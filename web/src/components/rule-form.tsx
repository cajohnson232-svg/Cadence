"use client";

// The one rule form: pick a template, fill in its typed parameters, choose who it applies to
// and whether it is hard or soft. Used for manual rules and for confirming an AI-proposed rule.
import Link from "next/link";
import { useActionState, useState } from "react";
import lib from "@/lib/rule-templates.json";
import type { RuleDraft, RuleFormState, RuleRefs } from "@/lib/rule-types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { DOW, cn } from "@/lib/util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const TEMPLATES = lib.templates as Any[];
const GROUPS = [...new Set(TEMPLATES.map((t) => t.group as string))];
const SCOPES = [["PROGRAM", "Whole program"], ["INSTITUTION", "One institution"], ["ROLE", "One role"], ["PARTICIPANT", "One participant"]] as const;
const TARGET = { INSTITUTION: ["institutionId", "Institution"], ROLE: ["roleId", "Role"], PARTICIPANT: ["participantId", "Participant"] } as const;
const LABELS: Record<string, string> = {
  n: "Number", hours: "Hours", ratio: "Multiple of the shift length", days: "Days", percent: "Percent", max_length: "Longest run (nights)",
  tolerance_shifts: "Allowed difference (shifts)", area_a: "First area", area_b: "Second area", min: "Minimum", max: "Maximum",
  weekdays: "On these days of the week", start: "From this time of day", category_ids: "These shift types", institution_ids: "At these places",
  participant_id: "The other person", together: "They must be on shift together (untick for: must NOT be together)", shift_id: "Shift", role_id: "Role",
  count: "How many", text: "The restriction, in words",
};

export function RuleForm({ action, initial, refs, cancelHref, submitLabel = "Save rule" }: {
  action: (prev: RuleFormState, fd: FormData) => Promise<RuleFormState>;
  initial: RuleDraft;
  refs: RuleRefs;
  cancelHref: string;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as RuleFormState);
  const [d, setD] = useState<RuleDraft>(initial);
  const t = TEMPLATES.find((x) => x.key === d.template);
  const set = (patch: Partial<RuleDraft>) => setD((p) => ({ ...p, ...patch }));
  const setParam = (k: string, v: Any) => setD((p) => ({ ...p, params: { ...p.params, [k]: v } }));
  const err = (k: string) => state.errors?.[k];
  const Err = ({ k }: { k: string }) => (err(k) ? <p className="mt-1 text-xs font-medium text-red-700">{err(k)}</p> : null);
  const bad = (k: string) => (err(k) ? "border-red-400" : undefined);

  const pickTemplate = (key: string) => {
    const nt = TEMPLATES.find((x) => x.key === key);
    const params: Record<string, Any> = {};
    if (nt) for (const [k, s] of Object.entries<Any>(nt.params.properties ?? {})) if (s.type === "boolean") params[k] = false;
    set({
      template: key, params,
      scope: nt && !nt.scopes.includes(d.scope) ? nt.scopes[0] : d.scope,
      level: nt && !nt.levels.includes(d.level) ? nt.levels[0] : d.level,
      needsReview: key === "custom" ? true : d.needsReview && d.template === "custom" ? false : d.needsReview,
    });
  };
  const name = (ref: keyof RuleRefs, id: string) => {
    const label = refs[ref].find((o) => o.value === id)?.label ?? "?";
    return ref === "Institution" ? label.replace(/^.*? · /, "") : label;       // "LBJ · LBJ Hospital" -> "LBJ Hospital"
  };
  const sentence = () => {
    if (!t) return "";
    if (t.key === "unavailable") {
      const p = d.params, parts: string[] = [];
      if (p.category_ids?.length) parts.push(p.category_ids.map((i: string) => name("ShiftCategory", i)).join("/") + " shifts");
      if (p.institution_ids?.length) parts.push("at " + p.institution_ids.map((i: string) => name("Institution", i)).join(", "));
      if (p.weekdays?.length) parts.push("on " + [...p.weekdays].sort().map((i: number) => DOW[i]).join(", "));
      if (p.start) parts.push(`from ${p.start}${p.hours ? ` for ${p.hours}h` : ""}`);
      return "Cannot work " + (parts.length ? parts.join(" ") : "at all") + (d.activeFrom || d.activeTo ? ` (${d.activeFrom || "…"} to ${d.activeTo || "…"})` : "");
    }
    return (t.sentence as string).replace(/\{(\w+)\}/g, (_, k) => {
      const s = t.params.properties?.[k], v = d.params[k];
      if (k === "together") return v ? "Must" : "Must not";
      if (v === undefined || v === "" || v === null) return "…";
      return s?.["x-ref"] ? name(s["x-ref"], v) : String(v);
    });
  };
  const enforced = t && t.solver === "enforced" && (t.enforcedScopes ?? []).includes(d.scope)
    && !((t.key === "unavailable" || t.key === "min_hours_off_between_shifts") && d.level !== "HARD") && !d.needsReview;

  const param = (k: string, s: Any) => {
    const v = d.params[k];
    const id = "p_" + k;
    const label = t.key === "unavailable" && k === "hours" ? "For this many hours" : LABELS[k] ?? k;
    const ref = s["x-ref"] ?? s.items?.["x-ref"];
    if (s.type === "boolean")
      return <label key={k} className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={!!v} onChange={(e) => setParam(k, e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-brand)]" />{label}</label>;
    if (s.type === "array" && s.items?.type === "integer")
      return (
        <div key={k} className="sm:col-span-2"><Label>{label}</Label>
          <div className="flex flex-wrap gap-1.5">{DOW.map((dn, i) => (
            <label key={dn} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
              <input type="checkbox" className="size-3.5 accent-[var(--color-brand)]" checked={(v ?? []).includes(i)}
                onChange={(e) => setParam(k, e.target.checked ? [...(v ?? []), i] : (v ?? []).filter((x: number) => x !== i))} />{dn}
            </label>))}
          </div><Err k={`params.${k}`} /></div>
      );
    if (s.type === "array")
      return (
        <div key={k} className="sm:col-span-2"><Label>{label}</Label>
          <div className="grid gap-x-4 gap-y-1 rounded-md border border-line bg-white p-3 sm:grid-cols-2">{refs[ref as keyof RuleRefs].map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={(v ?? []).includes(o.value)}
                onChange={(e) => setParam(k, e.target.checked ? [...(v ?? []), o.value] : (v ?? []).filter((x: string) => x !== o.value))} />{o.label}
            </label>))}
          </div><Err k={`params.${k}`} /></div>
      );
    if (ref)
      return (
        <div key={k}><Label htmlFor={id}>{label}</Label>
          <Select id={id} value={v ?? ""} onChange={(e) => setParam(k, e.target.value)} className={bad(`params.${k}`)}>
            <option value="">Choose…</option>{refs[ref as keyof RuleRefs].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select><Err k={`params.${k}`} /></div>
      );
    if (k === "text")
      return <div key={k} className="sm:col-span-2"><Label htmlFor={id}>{label}</Label><Textarea id={id} value={v ?? ""} onChange={(e) => setParam(k, e.target.value)} className={bad(`params.${k}`)} /><Err k={`params.${k}`} /></div>;
    const time = s.type === "string" && s.pattern;
    return (
      <div key={k}><Label htmlFor={id}>{label}</Label>
        <Input id={id} type={time ? "time" : "number"} value={v ?? ""} min={s.minimum} max={s.maximum} step={s.type === "integer" ? 1 : time ? undefined : "any"}
          onChange={(e) => setParam(k, e.target.value)} className={bad(`params.${k}`)} /><Err k={`params.${k}`} /></div>
    );
  };

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="draft" value={JSON.stringify(d)} />
      {state.message && <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</div>}
      <div>
        <Label htmlFor="template">Rule template<span className="text-red-600"> *</span></Label>
        <Select id="template" value={d.template} onChange={(e) => pickTemplate(e.target.value)} className={bad("template")}>
          <option value="">Choose a template…</option>
          {GROUPS.map((g) => <optgroup key={g} label={g}>{TEMPLATES.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>)}
        </Select>
        <Err k="template" />
      </div>
      {t && (
        <>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {Object.entries<Any>(t.params.properties ?? {}).map(([k, s]) => param(k, s))}
            {err("params") && <p className="text-xs font-medium text-red-700 sm:col-span-2">{err("params")}</p>}
          </div>
          <div className="rounded-md bg-surface px-3 py-2 text-sm" data-testid="rule-sentence"><span className="text-muted">Reads as: </span>{sentence()}</div>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="scope">Applies to<span className="text-red-600"> *</span></Label>
              <Select id="scope" value={d.scope} onChange={(e) => set({ scope: e.target.value as RuleDraft["scope"] })} className={bad("scope")}>
                {SCOPES.map(([k, l]) => <option key={k} value={k} disabled={!t.scopes.includes(k)}>{l}{t.scopes.includes(k) ? "" : " (not available for this template)"}</option>)}
              </Select>
              <Err k="scope" />
            </div>
            {d.scope !== "PROGRAM" && (() => {
              const [field, ref] = TARGET[d.scope as keyof typeof TARGET];
              return (
                <div>
                  <Label htmlFor="target">Which {d.scope.toLowerCase()}<span className="text-red-600"> *</span></Label>
                  <Select id="target" value={d[field]} onChange={(e) => set({ [field]: e.target.value } as Partial<RuleDraft>)} className={bad(field)}>
                    <option value="">Choose…</option>{refs[ref].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                  <Err k={field} />
                </div>
              );
            })()}
            <div className="sm:col-span-2">
              <Label>Level<span className="text-red-600"> *</span></Label>
              <div className="flex flex-wrap gap-2">
                {([["HARD", "Hard: must never be violated"], ["SOFT", "Soft: a goal, with a weight"]] as const).map(([k, l]) => (
                  <label key={k} className={cn("flex items-center gap-2 rounded-md border border-line bg-white px-3 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft", !t.levels.includes(k) && "opacity-50")}>
                    <input type="radio" name="level-radio" checked={d.level === k} disabled={!t.levels.includes(k)} onChange={() => set({ level: k })} className="accent-[var(--color-brand)]" />{l}
                  </label>
                ))}
              </div>
              <Err k="level" />
            </div>
            {d.level === "SOFT" && (
              <>
                <div><Label htmlFor="weight">Weight (1–10)</Label><Input id="weight" type="number" min={1} max={10} value={d.weight} onChange={(e) => set({ weight: e.target.value })} className={bad("weight")} />
                  <p className="mt-1 text-xs text-muted">How much it matters next to other rules of the same priority</p><Err k="weight" /></div>
                <div><Label htmlFor="priority">Priority</Label><Input id="priority" type="number" min={1} max={99} value={d.priority} onChange={(e) => set({ priority: e.target.value })} className={bad("priority")} />
                  <p className="mt-1 text-xs text-muted">The order the engine works through goals: 1 first. The built-in goals use 1–8, requests off 9</p><Err k="priority" /></div>
              </>
            )}
            <div><Label htmlFor="activeFrom">Active from</Label><Input id="activeFrom" type="date" value={d.activeFrom} onChange={(e) => set({ activeFrom: e.target.value })} /><p className="mt-1 text-xs text-muted">Blank = no start limit</p></div>
            <div><Label htmlFor="activeTo">Active to</Label><Input id="activeTo" type="date" value={d.activeTo} onChange={(e) => set({ activeTo: e.target.value })} className={bad("activeTo")} /><p className="mt-1 text-xs text-muted">Blank = ongoing</p><Err k="activeTo" /></div>
            <div className="sm:col-span-2"><Label htmlFor="notes">Notes</Label><Textarea id="notes" value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />Switched on</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.needsReview || t.key === "custom"} disabled={t.key === "custom"} onChange={(e) => set({ needsReview: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />Flag for manual review</label>
          </div>
          <div className={cn("rounded-md px-3 py-2 text-sm", enforced ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800")} data-testid="engine-note">
            {enforced ? "The scheduling engine enforces this rule." : t.key === "custom" || d.needsReview
              ? "Flagged for manual review: saved and shown on the compiled rules list, never enforced automatically."
              : "Stored only for now: saved and shown on the compiled rules list, but the scheduling engine does not enforce it yet."}
            {!enforced && t.solverNote ? ` ${t.solverNote}` : ""}
          </div>
        </>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !t}>{pending ? "Saving…" : submitLabel}</Button>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
      </div>
    </form>
  );
}
