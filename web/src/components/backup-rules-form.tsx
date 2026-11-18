"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { readBackupRules, saveBackupRules } from "@/app/backup-actions";
import { describeBackupRules, type BackupRules } from "@/lib/backup-rules";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

export function BackupRulesForm({ shiftId, aiLabel, text: text0, rules: rules0, roles }: {
  shiftId: string; aiLabel: string; text: string; rules: BackupRules; roles: { id: string; name: string; eligible: boolean }[];
}) {
  const router = useRouter();
  const [text, setText] = useState(text0);
  const [rules, setRules] = useState<BackupRules>(rules0);
  const [elig, setElig] = useState<string[] | null>(null);          // null = leave the role grid as it is
  const [reading, setReading] = useState<{ explanation: string[]; by: string } | null>(null);
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [busy, start] = useTransition();
  const set = (p: Partial<BackupRules>) => setRules({ ...rules, ...p });
  const n = (v: string, d: number | null) => (v === "" ? d : Number(v));

  const read = () => start(async () => {
    setMsg(null);
    const r = await readBackupRules(shiftId, text);
    if ("error" in r) { setMsg({ error: r.error }); return; }
    setRules(r.rules); setElig(r.eligibleRoleIds); setReading({ explanation: r.explanation, by: r.by });
  });
  const save = () => start(async () => {
    const r = await saveBackupRules(shiftId, { text, rules, eligibleRoleIds: elig });
    setMsg(r);
    if (r.notice) { setElig(null); router.refresh(); }
  });

  return (
    <div className="space-y-4" data-testid="backup-rules">
      <div><Label htmlFor="bk-text">The rules, in your own words</Label>
        <Textarea id="bk-text" rows={3} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="e.g. PGY-2 and up only. No more than 3 backup days each, at least 4 days apart. 12 hours off before backup." /></div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy || !text.trim()} onClick={read}>{busy ? "Reading…" : "Turn into rules"}</Button>
        <span className="text-xs text-muted">Read by {aiLabel}. Check and edit the result, then save.</span>
      </div>
      {reading && (
        <div className="rounded-md bg-surface px-3 py-2 text-sm" data-testid="backup-reading">
          <p className="text-xs font-medium text-muted">How it was read ({reading.by})</p>
          <ul className="mt-1 list-disc pl-5">{reading.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-4">
        <div><Label htmlFor="bk-max">Most backup days per person</Label><Input id="bk-max" type="number" min={0} max={31} placeholder="No limit" value={rules.max_per_person ?? ""} onChange={(e) => set({ max_per_person: n(e.target.value, null) })} /></div>
        <div><Label htmlFor="bk-gap">Days between one person&apos;s backups</Label><Input id="bk-gap" type="number" min={0} max={14} value={rules.min_days_between} onChange={(e) => set({ min_days_between: n(e.target.value, 0) ?? 0 })} /></div>
        <div><Label htmlFor="bk-before">Hours off before</Label><Input id="bk-before" type="number" min={0} max={48} step={0.5} value={rules.rest_before_hours} onChange={(e) => set({ rest_before_hours: n(e.target.value, 0) ?? 0 })} /></div>
        <div><Label htmlFor="bk-after">Hours off after</Label><Input id="bk-after" type="number" min={0} max={48} step={0.5} value={rules.rest_after_hours} onChange={(e) => set({ rest_after_hours: n(e.target.value, 0) ?? 0 })} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rules.counts_as_shift} onChange={(e) => set({ counts_as_shift: e.target.checked })} className="size-4" />
        Counts as a worked shift (toward shift totals and hours). Leave unticked for on call only.</label>
      {elig && (
        <div className="rounded-md border border-line p-3 text-sm" data-testid="backup-roles">
          <p className="mb-1 font-medium">Who can take backup (from your words; saving updates the role grid below)</p>
          <div className="flex flex-wrap gap-4">{roles.map((r) => (
            <label key={r.id} className="flex items-center gap-2"><input type="checkbox" checked={elig.includes(r.id)} onChange={(e) => setElig(e.target.checked ? [...elig, r.id] : elig.filter((x) => x !== r.id))} className="size-4" />{r.name}</label>
          ))}</div>
        </div>
      )}
      {rules.not_understood && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Not understood, so not enforced: &quot;{rules.not_understood}&quot; <button type="button" className="ml-2 underline" onClick={() => set({ not_understood: undefined })}>Dismiss</button>
        </div>
      )}
      <p className="text-sm text-muted" data-testid="backup-summary">Reads as: {describeBackupRules(rules)}{!elig ? `; ${roles.filter((r) => r.eligible).map((r) => r.name).join(", ") || "nobody"} can take it` : ""}.</p>
      {msg?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{msg.error}</p>}
      {msg?.notice && <p role="alert" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg.notice}</p>}
      <Button type="button" disabled={busy} onClick={save}>Save backup rules</Button>
    </div>
  );
}
