// The built-in (keyword) reader for backup rules, on realistic phrasings. Run with AI_PROVIDER=mock so Claude is not used:
//   AI_PROVIDER=mock npx tsx tests/backup-reader-check.ts
import { proposeBackupRules } from "../src/lib/assist";

const roles = [{ id: "pgy1", name: "PGY-1", level: 1 }, { id: "pgy2", name: "PGY-2", level: 2 }, { id: "pgy3", name: "PGY-3", level: 3 }];
type Want = Partial<{ max: number | null; min: number | null; gap: number; after: boolean; before: boolean; vac: boolean; before_h: number; after_h: number; counts: boolean; who: string[] | null; left: boolean }>;
const cases: [string, Want][] = [
  ["Seniors cover backup. Nobody should be on backup the day after a night shift, and each senior should have roughly the same number of backup days.", { who: ["pgy3"], after: true, before: false, left: false }],
  ["PGY-2s and PGY-3s only. Max 3 per person. Not back to back.", { who: ["pgy2", "pgy3"], max: 3, gap: 1, left: false }],
  ["PGY2/3 take backup, no more than 4 each and at least 3 days apart", { who: ["pgy2", "pgy3"], max: 4, gap: 3, left: false }],
  ["Interns can't take backup. Everyone else gets at least 2.", { who: ["pgy2", "pgy3"], min: 2, left: false }],
  ["No backup the day before or after nights. No backup right before vacation or the day you come back.", { before: true, after: true, vac: true, left: false }],
  ["Second and third years only; 3 backups max; 12 hours off before backup.", { who: ["pgy2", "pgy3"], max: 3, before_h: 12, left: false }],
  ["PGY-2 and up only. No more than 3 backup days each, at least 3 days apart.", { who: ["pgy2", "pgy3"], max: 3, gap: 3, left: false }],
  ["Backup is from home and does not count as a shift. Spread it evenly.", { counts: false, left: false }],
  ["Backup counts as a shift toward their totals.", { counts: true, left: false }],
  ["Backup person must live within 30 minutes of the hospital.", { left: true }],
];
let bad = 0;
(async () => {
  for (const [text, want] of cases) {
    const p = await proposeBackupRules(text, { today: "2026-11-19", roles });
    const r = p.rules, got: Required<Want> = { max: r.max_per_person, min: r.min_per_person, gap: r.min_days_between, after: r.not_after_night, before: r.not_before_night, vac: r.not_next_to_vacation,
      before_h: r.rest_before_hours, after_h: r.rest_after_hours, counts: r.counts_as_shift, who: p.eligibleRoleIds ? [...p.eligibleRoleIds].sort() : null, left: !!r.not_understood };
    const diffs = Object.entries(want).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((got as Record<string, unknown>)[k]));
    console.log(`${diffs.length ? "FAIL" : "ok  "} ${text}${diffs.length ? "\n       " + diffs.map(([k, v]) => `${k}: wanted ${JSON.stringify(v)}, got ${JSON.stringify((got as Record<string, unknown>)[k])}`).join("; ") + "\n       " + p.explanation.join(" | ") : ""}`);
    if (diffs.length) bad++;
  }
  console.log(bad ? `\n${bad} FAILED` : "\nBACKUP READER CHECKS PASSED");
  process.exit(bad ? 1 : 0);
})();
