// Optional places through the app: shifts whose maximum headcount is above the minimum (two LBJ shifts that need 1
// and can take 2) and a shift that needs nobody (a PGY-3-only "Dugout", 0-1). With every role's minimum raised to its
// maximum the required places alone are too few; the schedule must use extra places to get everyone there, store
// them as ordinary shifts (not open ones), and keep every hard rule and the role grid.
//   npm run db:reset && npx tsx tests/optional-places-check.ts        (about 2 minutes)
import "dotenv/config";
import { db } from "../src/lib/db";
import { settleRun, startRun } from "../src/lib/engine";
import { compileInterval } from "../src/lib/compile";
import { eligibilityProblems, publishChecks } from "../src/lib/schedules";

const IV = "iv_7";
let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("This test changes data. It only runs against a database on localhost.");
  await db.schedule.deleteMany({ where: { intervalId: IV } });
  const lbj = await db.institution.findFirstOrThrow({ where: { programId: "prog_demo", shortCode: "LBJ" } });
  const two = await db.shift.findMany({ where: { programId: "prog_demo", institutionId: lbj.id, name: { in: ["Swing CC", "Night GP"] } } });
  await db.shift.updateMany({ where: { id: { in: two.map((s) => s.id) } }, data: { maxParticipants: 2 } });
  const day = await db.shiftCategory.findFirstOrThrow({ where: { programId: "prog_demo", name: "Day" } });
  const area = await db.area.findFirstOrThrow({ where: { institutionId: lbj.id } });
  const dug = await db.shift.create({ data: { programId: "prog_demo", institutionId: lbj.id, areaId: area.id, categoryId: day.id, name: "Dugout", startMinute: 600, durationMinutes: 600,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6], minParticipants: 0, maxParticipants: 1, active: true } });
  const roles = await db.role.findMany({ where: { programId: "prog_demo" } });
  await db.shiftRole.createMany({ data: roles.map((r) => ({ shiftId: dug.id, roleId: r.id, eligible: r.id === "role_pgy3", requiredCount: 0 })) });
  for (const r of roles) if (r.defaultMaxShifts) await db.role.update({ where: { id: r.id }, data: { defaultMinShifts: r.defaultMaxShifts } });

  const c = await compileInterval(IV);
  const T = c.config.shift_templates as { ref: string; headcount: number; max_headcount: number }[];
  ok(T.filter((t) => two.some((s) => s.id === t.ref)).every((t) => t.headcount === 1 && t.max_headcount === 2) && T.some((t) => t.ref === dug.id && t.headcount === 0 && t.max_headcount === 1),
    "the engine is sent each shift's minimum and maximum (LBJ Swing CC and Night GP 1-2, Dugout 0-1)");
  ok(!c.warnings.some((w) => /staffs to the minimum headcount/.test(w)), "the warning about staffing to the minimum is gone");

  const r = await startRun(IV, null, { seconds: 45, polish: 10 });
  if (!r.ok) throw new Error(r.error);
  let st: string | null = "";
  for (let i = 0; i < 600; i++) { st = await settleRun(r.scheduleId); if (st !== "RUNNING" && st !== "QUEUED") break; await sleep(500); }
  const sch = await db.schedule.findUniqueOrThrow({ where: { id: r.scheduleId } });
  ok(st === "DONE", `a schedule is generated (${st}${sch.error ? ": " + sch.error : ""})`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rep = sch.report as any;
  const short = (rep.residents as { shifts: number; shifts_min: number }[]).reduce((a, p) => a + Math.max(0, p.shifts_min - p.shifts), 0);
  const need = rep.validator.total_shifts as number, mins = (rep.residents as { shifts_min: number }[]).reduce((a, p) => a + p.shifts_min, 0);
  ok(rep.validator.hard_violations.length === 0 && rep.validator.open_shifts === 0, "no hard rule broken, every required place filled");
  ok(short === 0, `everyone reaches their minimum (${mins} needed against ${need} required places; ${short} short)`);
  ok(rep.validator.extra_places_used === mins - need, `extra places used: ${rep.validator.extra_places_used}, exactly the ${mins - need} needed`);

  const rows = await db.scheduledShift.findMany({ where: { scheduleId: r.scheduleId, backup: false }, include: { participant: true } });
  const onDug = rows.filter((x) => x.shiftId === dug.id);
  ok(onDug.every((x) => x.participant?.roleId === "role_pgy3"), `Dugout worked ${onDug.length} time(s), only by PGY-3s`);
  ok(rows.filter((x) => !x.participantId).length === 0, "no optional place is stored as an open shift");
  const perDay = new Map<string, number>();
  for (const x of rows.filter((x) => two.some((s) => s.id === x.shiftId))) perDay.set(x.shiftId + x.dutyDate.toISOString(), (perDay.get(x.shiftId + x.dutyDate.toISOString()) ?? 0) + 1);
  ok([...perDay.values()].every((n) => n >= 1 && n <= 2) && [...perDay.values()].some((n) => n === 2), `the two LBJ shifts have 1 or 2 people each day (${[...perDay.values()].filter((n) => n === 2).length} days with 2)`);
  ok((await eligibilityProblems(r.scheduleId)).length === 0, "every shift respects the role grid and institutions");
  const chk = await publishChecks(r.scheduleId, "prog_demo");
  ok(!!chk && !chk.blocked && chk.open === 0, "it can be published");

  await db.schedule.deleteMany({ where: { intervalId: IV } });
  console.log(failed ? `\n${failed} FAILED` : "\nOPTIONAL PLACE CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
