// Two hard rules, end to end through the app: shift eligibility from the role grid, and at most 6 days worked in a row.
// A role grid that is NOT "PGY-x and up" (seniors barred from one shift, a rotator barred from another, PGY-1 and the
// rotator at the same level but eligible for different shifts), generated with both solvers and optimized once; every
// stored shift is then checked against the grid and every person's run of days, the previous interval's last week included.
//
//   npm run db:reset && npx tsx tests/hard-rules-check.ts        (about 4 minutes)
import "dotenv/config";
import { db } from "../src/lib/db";
import { settleRun, startRun } from "../src/lib/engine";
import { compileInterval } from "../src/lib/compile";
import { eligibilityProblems, publish, publishChecks } from "../src/lib/schedules";

const IV = "iv_7";
let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (id: string, seconds: number) => {
  for (let i = 0; i < seconds * 2; i++) { const st = await settleRun(id); if (st !== "RUNNING" && st !== "QUEUED") return st; await sleep(500); }
  return "TIMEOUT";
};
const day = (d: Date) => Math.round(d.getTime() / 86400000);

/** Every stored row against the grid in the database, written here from scratch (no app code). */
async function gridBreaks(sid: string) {
  const rows = await db.scheduledShift.findMany({ where: { scheduleId: sid, participantId: { not: null } }, include: { participant: true, specialShift: true } });
  const grid = new Map((await db.shiftRole.findMany()).map((g) => [g.shiftId + "|" + g.roleId, g.eligible]));
  return rows.filter((r) => { const g = r.shiftId ?? r.specialShift?.shiftId; return !g || grid.get(g + "|" + r.participant!.roleId) === false; });
}

/** Longest run of days worked per person: this schedule's clinical shifts plus the previous published schedule's. */
async function longestRuns(sid: string) {
  const prev = await db.schedule.findFirst({ where: { status: "PUBLISHED", interval: { endDate: { lt: (await db.interval.findUniqueOrThrow({ where: { id: IV } })).startDate } } }, orderBy: { interval: { endDate: "desc" } } });
  const rows = await db.scheduledShift.findMany({ where: { scheduleId: { in: [sid, ...(prev ? [prev.id] : [])] }, participantId: { not: null }, backup: false } });
  const by = new Map<string, Set<number>>();
  for (const r of rows) { if (!by.has(r.participantId!)) by.set(r.participantId!, new Set()); by.get(r.participantId!)!.add(day(r.dutyDate)); }
  const out: Record<string, number> = {};
  for (const [p, ds] of by) { let best = 0, cur = 0, last = -1e9; for (const d of [...ds].sort((a, b) => a - b)) { cur = d === last + 1 ? cur + 1 : 1; best = Math.max(best, cur); last = d; } out[p] = best; }
  return out;
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("This test changes data. It only runs against a database on localhost.");
  await db.schedule.deleteMany({ where: { intervalId: IV } });

  // a grid that min-PGY alone cannot express
  const set = (shiftId: string, roleIds: string[], eligible: boolean) => db.shiftRole.updateMany({ where: { shiftId, roleId: { in: roleIds } }, data: { eligible } });
  await set("s_ft", ["role_pgy2", "role_pgy3"], false);     // Fast track: juniors only
  await set("s_sc", ["role_rot"], false);                    // rotator barred from one shift PGY-1s can work
  await set("s_em", ["role_pgy1"], false);                   // ... and PGY-1s barred from one the rotator can work (same level)

  const c = await compileInterval(IV);
  const R = c.config.residents as { id: string; only_shifts?: string[]; max_consecutive_days?: number }[];
  ok(R.every((r) => Array.isArray(r.only_shifts) && r.only_shifts.length > 0), "every person is sent their own list of allowed shifts");
  const p = await db.participant.findMany({ where: { id: { in: R.map((r) => r.id) } } });
  const role = new Map(p.map((x) => [x.id, x.roleId]));
  ok(R.filter((r) => role.get(r.id) === "role_pgy3").every((r) => !r.only_shifts!.includes("s_ft")) && R.filter((r) => role.get(r.id) === "role_pgy1").every((r) => r.only_shifts!.includes("s_ft") && !r.only_shifts!.includes("s_em")),
    "the lists follow the grid (no Fast track for PGY-3s; PGY-1s get Fast track but not Evening M)");
  ok((c.config.rules as { max_consecutive_days?: number }).max_consecutive_days === 6, "the program's limit of 6 days in a row is sent to the engine");
  ok(c.compiledRules.some((e) => e.template === "max_days_in_a_row" && e.engine === "enforced" && /No more than 6 days worked in a row/.test(e.text)), "it is listed as an enforced hard rule");

  for (const backend of ["highs", "cpsat"]) {
    process.env.ENGINE_BACKEND = backend;
    const r = await startRun(IV, null, { seconds: 25, polish: 10 });
    if (!r.ok) throw new Error(r.error);
    ok((await until(r.scheduleId, 200)) === "DONE", `${backend}: a schedule is generated`);
    const breaks = await gridBreaks(r.scheduleId);
    ok(breaks.length === 0, `${backend}: every shift and backup day is one the person's role is eligible for (${breaks.length} not)`);
    ok((await eligibilityProblems(r.scheduleId)).length === 0, `${backend}: the site's own grid check agrees`);
    const runs = await longestRuns(r.scheduleId);
    const worst = Math.max(...Object.values(runs));
    ok(worst <= 6, `${backend}: nobody works more than 6 days in a row, the previous interval's last week included (longest: ${worst})`);
    const sch = await db.schedule.findUniqueOrThrow({ where: { id: r.scheduleId } });
    const open = await db.scheduledShift.count({ where: { scheduleId: r.scheduleId, participantId: null, backup: false } });
    ok(((sch.report as { validator?: { hard_violations?: string[] } })?.validator?.hard_violations ?? []).length === 0, `${backend}: the engine's own checker finds nothing broken (${open} shift(s) open)`);
  }
  delete process.env.ENGINE_BACKEND;

  // optimize: starts from a schedule, matched by shift id; the result must still respect both rules
  const base = await db.schedule.findFirstOrThrow({ where: { intervalId: IV, runStatus: "DONE" }, orderBy: { createdAt: "asc" } });
  const o = await startRun(IV, null, { seconds: 20, polish: 5 }, { scheduleId: base.id, label: base.label ?? "Run" });
  if (!o.ok) throw new Error(o.error);
  ok((await until(o.scheduleId, 200)) === "DONE", "optimizing finishes");
  ok((await gridBreaks(o.scheduleId)).length === 0 && Math.max(...Object.values(await longestRuns(o.scheduleId))) <= 6, "the optimized schedule respects the grid and the 6-day limit");

  // a grid change after generating: the schedule is refused for publishing, naming the person and the shift
  const victim = await db.scheduledShift.findFirstOrThrow({ where: { scheduleId: o.scheduleId, shiftId: "s_dm", backup: false, participantId: { not: null } }, include: { participant: { include: { role: true } } } });
  await set("s_dm", [victim.participant!.roleId], false);
  const chk = await publishChecks(o.scheduleId, "prog_demo");
  ok(!!chk?.blocked && chk.violations.some((v) => v.startsWith(`Role grid: ${victim.participant!.firstName} ${victim.participant!.lastName} (${victim.participant!.role.name}) is on Day M`)),
    `after ${victim.participant!.role.name} is made ineligible for Day M, the schedule is blocked and the review names the shifts (${chk?.violations.filter((v) => v.startsWith("Role grid")).length} found)`);
  const pub = await publish(o.scheduleId, "prog_demo", true);
  ok(!pub.ok && /cannot be published/.test(pub.error), "publishing is refused even with the tick");
  await set("s_dm", [victim.participant!.roleId], true);

  // a special-day extra shift saved without a normal shift to copy (possible before 18 Nov): nobody can be put on it
  const sd = await db.specialStaffingDay.findFirstOrThrow({ where: { programId: "prog_demo" } });
  const line = await db.specialStaffingShift.create({ data: { specialStaffingDayId: sd.id, action: "ADD", shiftId: null, name: "Ad hoc", categoryId: (await db.shiftCategory.findFirstOrThrow({ where: { programId: "prog_demo", isNight: false } })).id, startMinute: 600, durationMinutes: 480, minParticipants: 1 } });
  const c2 = await compileInterval(IV);
  const t = (c2.config.shift_templates as { ref: string }[]).find((x) => x.ref === `line:${line.id}`);
  ok(!!t && (c2.config.residents as { only_shifts: string[] }[]).every((r) => !r.only_shifts.includes(t.ref)) && c2.warnings.some((w) => /Ad hoc\) does not say which normal shift it is like/.test(w)),
    "an extra shift with no normal shift to copy is open to nobody, with a warning saying how to fix it");
  await db.specialStaffingShift.delete({ where: { id: line.id } });

  await db.schedule.deleteMany({ where: { intervalId: IV } });
  console.log(failed ? `\n${failed} FAILED` : "\nHARD RULE CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
