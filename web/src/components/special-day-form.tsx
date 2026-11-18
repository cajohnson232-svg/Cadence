"use client";
// A special staffing day. "Replace" lists every shift at the institution (active and inactive) to tick the
// ones that run; "Modify" takes the changes in plain words, reads them into lines you can edit, then saves.
import { useMemo, useState, useTransition } from "react";
import { readDayChanges, saveSpecialDay, type DayPayload } from "@/app/special-day-actions";
import type { DayLine } from "@/lib/assist";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { DOW, cn, dow, hhmm, parseYmd, toMinutes } from "@/lib/util";

export type SDShift = { id: string; institutionId: string; name: string; startMinute: number; durationMinutes: number; minParticipants: number; categoryId: string; daysOfWeek: number[]; active: boolean };
type Props = {
  id: string | null; institutions: { id: string; name: string }[]; categories: { id: string; name: string }[]; shifts: SDShift[];
  initial: DayPayload; aiLabel: string;
};
const t2m = (v: string) => (/^\d{1,2}:\d{2}$/.test(v) ? toMinutes(v) : null);
const blankLine = (): DayLine => ({ action: "CHANGE", shiftId: null, name: null, categoryId: null, startMinute: null, durationMinutes: null, minParticipants: null });

export function SpecialDayForm({ id, institutions, categories, shifts, initial, aiLabel }: Props) {
  const [f, setF] = useState<DayPayload>(initial);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ explanation: string[]; by: string } | null>(null);
  const [busy, start] = useTransition();
  const here = useMemo(() => shifts.filter((x) => x.institutionId === f.institutionId), [shifts, f.institutionId]);
  const wd = /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? dow(parseYmd(f.date)) : null;
  const byId = new Map(shifts.map((x) => [x.id, x]));
  const set = (patch: Partial<DayPayload>) => { setF({ ...f, ...patch }); setError(null); };
  const setLine = (i: number, patch: Partial<DayLine>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const chosen = new Map(f.lines.filter((l) => l.action === "ADD" && l.shiftId).map((l) => [l.shiftId!, l]));

  const switchMode = (mode: "MODIFY" | "REPLACE") => {
    if (mode === f.mode) return;
    // Replace starts with the shifts that normally run that day ticked
    const lines = mode === "REPLACE"
      ? here.filter((x) => x.active && wd != null && x.daysOfWeek.includes(wd)).map((x) => ({ ...blankLine(), action: "ADD" as const, shiftId: x.id }))
      : [];
    set({ mode, lines });
    setReading(null);
  };
  const toggle = (x: SDShift, on: boolean) => set({ lines: on ? [...f.lines, { ...blankLine(), action: "ADD", shiftId: x.id }] : f.lines.filter((l) => l.shiftId !== x.id) });
  const read = () => start(async () => {
    const r = await readDayChanges({ institutionId: f.institutionId, date: f.date, text: f.changeText });
    if ("error" in r) { setError(r.error); return; }
    set({ lines: r.lines });
    setReading({ explanation: r.explanation, by: r.by });
  });
  const save = () => start(async () => {
    const r = await saveSpecialDay(id, f);
    if (r && "error" in r) setError(r.error);
  });

  return (
    <div className="space-y-5" data-testid="special-day-form">
      <div className="grid gap-4 sm:grid-cols-3">
        <div><Label htmlFor="sd-inst">Institution</Label>
          <Select id="sd-inst" value={f.institutionId} onChange={(e) => set({ institutionId: e.target.value, lines: [] })}>
            <option value="">Choose…</option>{institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></div>
        <div><Label htmlFor="sd-date">Date</Label><Input id="sd-date" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
          {wd != null && <p className="mt-1 text-xs text-muted">{DOW[wd]}</p>}</div>
        <div><Label htmlFor="sd-name">Name</Label><Input id="sd-name" value={f.name} placeholder="Thanksgiving" onChange={(e) => set({ name: e.target.value })} /></div>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">What happens that day</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={f.mode === "MODIFY"} onChange={() => switchMode("MODIFY")} />Modify: the normal shifts run, with changes</label>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={f.mode === "REPLACE"} onChange={() => switchMode("REPLACE")} />Replace: only the shifts I choose run</label>
        </div>
      </fieldset>

      {!f.institutionId ? <p className="text-sm text-muted">Choose the institution to see its shifts.</p> : f.mode === "REPLACE" ? (
        <div data-testid="replace-list">
          <p className="mb-2 text-sm text-muted">Tick the shifts that run that day. Inactive shifts are listed too, for days that need a shift you do not normally run. You can change a shift&apos;s time or people for that day only.</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="py-1 pr-2">Runs</th><th className="py-1 pr-2">Shift</th><th className="py-1 pr-2">Usually</th><th className="py-1 pr-2">Start that day</th><th className="py-1 pr-2">Hours</th><th className="py-1">People</th></tr></thead>
            <tbody className="divide-y divide-line">
              {here.map((x) => {
                const l = chosen.get(x.id), i = f.lines.indexOf(l!);
                return (
                  <tr key={x.id} className={cn(!l && "text-muted")}>
                    <td className="py-1.5 pr-2"><input type="checkbox" aria-label={`Run ${x.name}`} checked={!!l} onChange={(e) => toggle(x, e.target.checked)} className="size-4" /></td>
                    <td className="py-1.5 pr-2">{x.name} {!x.active && <Badge>Inactive</Badge>}{x.active && wd != null && !x.daysOfWeek.includes(wd) && <Badge className="ml-1">Not usually on {DOW[wd]}</Badge>}</td>
                    <td className="py-1.5 pr-2 text-xs">{hhmm(x.startMinute)}, {x.durationMinutes / 60}h, {x.minParticipants}</td>
                    <td className="py-1.5 pr-2">{l && <Input type="time" aria-label={`Start of ${x.name}`} className="w-28" value={l.startMinute == null ? "" : hhmm(l.startMinute)} onChange={(e) => setLine(i, { startMinute: t2m(e.target.value) })} />}</td>
                    <td className="py-1.5 pr-2">{l && <Input type="number" aria-label={`Hours of ${x.name}`} className="w-20" min={0.5} max={48} step={0.5} value={l.durationMinutes == null ? "" : l.durationMinutes / 60} onChange={(e) => setLine(i, { durationMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : null })} />}</td>
                    <td className="py-1.5">{l && <Input type="number" aria-label={`People on ${x.name}`} className="w-20" min={0} max={50} value={l.minParticipants ?? ""} onChange={(e) => setLine(i, { minParticipants: e.target.value === "" ? null : Number(e.target.value) })} />}</td>
                  </tr>
                );
              })}
              {!here.length && <tr><td colSpan={6} className="py-3 text-muted">This institution has no shifts yet.</td></tr>}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">Empty boxes keep the shift&apos;s usual value.</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="modify-panel">
          <div><Label htmlFor="sd-text">Describe the changes</Label>
            <Textarea id="sd-text" rows={3} value={f.changeText} onChange={(e) => set({ changeText: e.target.value })}
              placeholder="e.g. No Fast track. Day M starts at 9 and lasts 6 hours. Add an extra evening shift at 15:00 for 8 hours." /></div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" disabled={busy || !f.changeText.trim()} onClick={read}>{busy ? "Reading…" : "Read the changes"}</Button>
            <span className="text-xs text-muted">Read by {aiLabel}. You can edit the result before saving.</span>
          </div>
          {reading && (
            <div className="rounded-md bg-surface px-3 py-2 text-sm" data-testid="reading">
              <p className="text-xs font-medium text-muted">How it was read ({reading.by})</p>
              <ul className="mt-1 list-disc pl-5">{reading.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <table className="w-full text-sm" data-testid="modify-lines">
            <thead><tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="py-1 pr-2">Change</th><th className="py-1 pr-2">Shift</th><th className="py-1 pr-2">Name (new shift)</th><th className="py-1 pr-2">Category</th><th className="py-1 pr-2">Start</th><th className="py-1 pr-2">Hours</th><th className="py-1 pr-2">People</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {f.lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-2"><Select aria-label={`Change ${i + 1}`} value={l.action} className="w-36" onChange={(e) => setLine(i, { action: e.target.value as DayLine["action"] })}>
                    <option value="CHANGE">Changes</option><option value="REMOVE">Does not run</option><option value="ADD">Extra shift</option></Select></td>
                  <td className="py-1.5 pr-2"><Select aria-label={`Shift ${i + 1}`} value={l.shiftId ?? ""} className="w-48" onChange={(e) => setLine(i, { shiftId: e.target.value || null })}>
                    <option value="">{l.action === "ADD" ? "A new shift" : "Choose…"}</option>{here.map((x) => <option key={x.id} value={x.id}>{x.name}{x.active ? "" : " (inactive)"}</option>)}</Select></td>
                  {l.action === "REMOVE" ? <td colSpan={5} className="py-1.5 pr-2 text-xs text-muted">{l.shiftId ? `${byId.get(l.shiftId)?.name} does not run that day.` : ""}</td> : <>
                    <td className="py-1.5 pr-2">{l.action === "ADD" && <Input aria-label={`Name ${i + 1}`} value={l.name ?? ""} className="w-40" onChange={(e) => setLine(i, { name: e.target.value || null })} />}</td>
                    <td className="py-1.5 pr-2"><Select aria-label={`Category ${i + 1}`} value={l.categoryId ?? ""} className="w-32" onChange={(e) => setLine(i, { categoryId: e.target.value || null })}>
                      <option value="">{l.shiftId ? "As usual" : "Choose…"}</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                    <td className="py-1.5 pr-2"><Input type="time" aria-label={`Start ${i + 1}`} className="w-28" value={l.startMinute == null ? "" : hhmm(l.startMinute)} onChange={(e) => setLine(i, { startMinute: t2m(e.target.value) })} /></td>
                    <td className="py-1.5 pr-2"><Input type="number" aria-label={`Hours ${i + 1}`} className="w-20" min={0.5} max={48} step={0.5} value={l.durationMinutes == null ? "" : l.durationMinutes / 60} onChange={(e) => setLine(i, { durationMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : null })} /></td>
                    <td className="py-1.5 pr-2"><Input type="number" aria-label={`People ${i + 1}`} className="w-20" min={0} max={50} value={l.minParticipants ?? ""} onChange={(e) => setLine(i, { minParticipants: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                  </>}
                  <td className="py-1.5 text-right"><button type="button" className="text-xs text-red-700 hover:underline" onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
              {!f.lines.length && <tr><td colSpan={8} className="py-3 text-muted">No changes yet.</td></tr>}
            </tbody>
          </table>
          <button type="button" className="text-sm text-brand hover:underline" onClick={() => set({ lines: [...f.lines, blankLine()] })}>+ Add a line by hand</button>
          <p className="text-xs text-muted">Empty boxes on a changed shift keep its usual value.</p>
        </div>
      )}

      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <Button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save special staffing day"}</Button>
    </div>
  );
}
