"use client";
// Where a participant works in an interval. With two or more institutions ticked, the share of shifts at each
// is required and must add up to 100%; dates at each institution are optional.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/util";

export type InstRow = { id: string; name: string; code: string; on: boolean; pct: number | null; from: string; until: string };

export function InstitutionsForm({ action, rows, min, max }: { action: (fd: FormData) => void; rows: InstRow[]; min: string; max: string }) {
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(rows.map((r) => [r.id, r.on])));
  const [pct, setPct] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.id, r.pct == null ? "" : String(r.pct)])));
  const chosen = rows.filter((r) => on[r.id]);
  const split = chosen.length > 1;
  const sum = chosen.reduce((t, r) => t + (Number(pct[r.id]) || 0), 0);
  return (
    <form action={action} className="space-y-3" data-testid="institutions-form">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted">
          <th className="py-1 pr-3">Institution</th><th className="py-1 pr-3">{split ? "Share of shifts" : ""}</th><th className="py-1 pr-3">Only from</th><th className="py-1">Only until</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cn(!on[r.id] && "text-muted")}>
              <td className="py-1.5 pr-3">
                <label className="flex items-center gap-2"><input type="checkbox" name={`inst_${r.id}`} checked={!!on[r.id]} onChange={(e) => setOn({ ...on, [r.id]: e.target.checked })} className="size-4" />{r.name}</label>
              </td>
              <td className="py-1.5 pr-3">
                {split && on[r.id] && (
                  <span className="inline-flex items-center gap-1"><Input name={`pct_${r.id}`} aria-label={`Percent at ${r.name}`} inputMode="numeric" value={pct[r.id]}
                    onChange={(e) => setPct({ ...pct, [r.id]: e.target.value.replace(/\D/g, "").slice(0, 3) })} className="w-20" required />%</span>
                )}
              </td>
              <td className="py-1.5 pr-3"><Input type="date" name={`from_${r.id}`} aria-label={`Only from, ${r.name}`} defaultValue={r.from} min={min} max={max} disabled={!on[r.id]} className="w-40" /></td>
              <td className="py-1.5"><Input type="date" name={`until_${r.id}`} aria-label={`Only until, ${r.name}`} defaultValue={r.until} min={min} max={max} disabled={!on[r.id]} className="w-40" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {split && <p className={cn("text-sm", sum === 100 ? "text-emerald-700" : "text-amber-800")} data-testid="pct-sum">Total: {sum}%{sum === 100 ? "" : " (must add up to 100%)"}</p>}
      <p className="text-xs text-muted">
        {split ? "The schedule aims for this split and counts it as met within one shift either way. " : ""}
        Leave the dates empty to allow the whole interval. With dates, they are only scheduled at that institution between them
        (for example, the first two weeks at one and the last two at the other).
      </p>
      <Button size="sm">Save institutions</Button>
    </form>
  );
}
