// The engine runner, without a browser: a real run is imported correctly, a cancelled run is stopped,
// and the three ways a run can fail are recorded with a reason instead of hanging.
//
//   npm run db:reset && npx tsx tests/engine-check.ts
import "dotenv/config";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { cancelRun, fingerprint, settleRun, startRun } from "../src/lib/engine";
import { compileInterval } from "../src/lib/compile";
import { publish, publishChecks, unpublish } from "../src/lib/schedules";
import { toMinutes } from "../src/lib/util";

const IV = "iv_7";
let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (id: string, seconds: number) => {
  for (let i = 0; i < seconds * 2; i++) { const st = await settleRun(id); if (st !== "RUNNING" && st !== "QUEUED") return st; await sleep(500); }
  return "TIMEOUT";
};

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("This test changes data. It only runs against a database on localhost.");
  await db.schedule.deleteMany({ where: { intervalId: IV } });

  // 1. a real run
  const c = await compileInterval(IV);
  const a = await startRun(IV, null, { seconds: 10, polish: 5 });
  ok(a.ok, "a run starts");
  if (!a.ok) throw new Error(a.error);
  const again = await startRun(IV, null, { seconds: 10, polish: 5 });
  ok(!again.ok && /already being generated/.test(again.error), "a second run for the same interval is refused while one is in progress");
  const running = await db.schedule.findUniqueOrThrow({ where: { id: a.scheduleId } });
  ok(running.runStatus === "RUNNING" && running.workerPid && running.inputHash === fingerprint(c.config), "the run is recorded as running, with the fingerprint of its inputs");
  const st = await until(a.scheduleId, 120);
  ok(st === "DONE", `the run finishes and is imported (status ${st})`);
  const sch0 = await db.schedule.findUniqueOrThrow({ where: { id: a.scheduleId }, include: { shifts: true } });
  const sch = { ...sch0, shifts: sch0.shifts.filter((x) => !x.backup) };            // backup (on-call) days are checked separately below
  const bk = sch0.shifts.filter((x) => x.backup), bkRep = (sch0.report as any).backup;
  ok(bkRep && bk.length === bkRep.days.length && bk.filter((x) => x.participantId).length === bkRep.days.reduce((t: number, d: any) => t + d.assigned.length, 0),
    `backup days are stored too, marked as backup (${bk.length} days, ${bk.filter((x) => x.participantId).length} covered)`);
  ok(bk.every((b) => !sch.shifts.some((x) => x.participantId && x.participantId === b.participantId && x.startsAt < b.endsAt && b.startsAt < x.endsAt)), "nobody is on backup while on a shift");
  const rep = sch.report as any;
  const total = rep.validator.total_shifts as number;
  ok(sch.shifts.length === total, `one row per person per shift: ${sch.shifts.length} rows for ${total} shifts to fill`);
  ok(sch.shifts.filter((s) => !s.participantId).length === rep.validator.open_shifts, `open shifts are stored as rows without a person (${rep.validator.open_shifts})`);
  ok(rep.validator.hard_violations.length === 0, "the engine's independent check found no hard-rule violations");
  ok(!("slots" in rep) && rep.goals.length === 12 && rep.residents.length === (c.config as any).residents.length, "the report keeps goals and per-person figures, not a second copy of the shifts");
  ok(sch.shifts.every((s) => s.endsAt > s.startsAt && s.institutionId && s.categoryId), "every row has a place, a category and a valid time");
  ok(!existsSync(running.workDir!), "the run's work folder is removed after import");
  ok((await settleRun(a.scheduleId)) === "DONE" && (await db.scheduledShift.count({ where: { scheduleId: a.scheduleId, backup: false } })) === total, "settling again does not import twice");
  // the stored rows agree with the engine's own per-person counts
  const per = new Map<string, number>();
  for (const s of sch.shifts) if (s.participantId) per.set(s.participantId, (per.get(s.participantId) ?? 0) + 1);
  ok(rep.residents.every((r: any) => (per.get(r.id) ?? 0) === r.shifts), "per-person shift counts in the database match the engine's report");
  // nobody is on a shift during approved vacation
  const vac = await db.timeOff.findMany({ where: { kind: "VACATION", status: "APPROVED", participantId: { in: [...per.keys()] } } });
  const clash = sch.shifts.filter((s) => vac.some((v) => v.participantId === s.participantId && v.startDate <= new Date(s.startsAt.toISOString().slice(0, 10)) && new Date(s.startsAt.toISOString().slice(0, 10)) <= v.endDate));
  ok(clash.length === 0, `nobody is scheduled on approved vacation (${vac.length} vacations checked)`);

  // 1b. publishing
  const PROG = (await db.interval.findUniqueOrThrow({ where: { id: IV } })).programId;
  const first = await publish(a.scheduleId, PROG, false);
  ok(first.ok, "a finished schedule with nothing open and unchanged inputs publishes without a confirmation");
  ok((await db.interval.findUniqueOrThrow({ where: { id: IV } })).status === "PUBLISHED", "publishing a schedule marks the interval as published");
  // a pending request is approved: the inputs are now different from what the schedule was built on
  await db.timeOff.update({ where: { id: "to7" }, data: { status: "APPROVED" } });
  ok((await publishChecks(a.scheduleId, PROG))!.stale, "approving a request afterwards marks the schedule as built on old inputs");
  const a2 = await startRun(IV, null, { seconds: 10, polish: 5 });
  if (!a2.ok) throw new Error(a2.error);
  const st2 = await until(a2.scheduleId, 120);
  ok(st2 === "DONE", `a second schedule can be generated while one is published (${st2}${st2 === "DONE" ? "" : ": " + ((await db.schedule.findUniqueOrThrow({ where: { id: a2.scheduleId } })).error ?? "")})`);
  ok(!(await publishChecks(a2.scheduleId, PROG))!.stale, "a schedule generated after the change is up to date");
  const chen = await db.scheduledShift.count({ where: { scheduleId: a2.scheduleId, backup: false, participantId: "p03", startsAt: { gte: new Date("2027-01-12T00:00:00Z"), lt: new Date("2027-01-13T00:00:00Z") } } });
  const repl = await publish(a2.scheduleId, PROG, false);
  ok(repl.ok, "the newer schedule can be published");
  const states = Object.fromEntries((await db.schedule.findMany({ where: { id: { in: [a.scheduleId, a2.scheduleId] } } })).map((x) => [x.id, x.status]));
  ok(states[a.scheduleId] === "SUPERSEDED" && states[a2.scheduleId] === "PUBLISHED", "publishing a newer schedule replaces the older one; only one is published");
  console.log(`     (Chen's newly approved request for 12 Jan: ${chen === 0 ? "granted" : "not granted"} in the new schedule; it is a soft request)`);
  let refused = false;
  try { await db.schedule.update({ where: { id: a.scheduleId }, data: { status: "PUBLISHED" } }); } catch { refused = true; }
  ok(refused, "the database itself refuses a second published schedule for one interval");

  // the next interval starts from the published schedule's last week
  const next = await db.interval.create({ data: { programId: PROG, name: "Block 8 (test)", startDate: new Date("2027-02-01"), endDate: new Date("2027-02-28") } });
  const everyone = await db.assignment.findMany({ where: { programId: PROG, endDate: { gte: new Date("2027-01-31") } } });
  for (const x of everyone) await db.assignment.create({ data: { programId: PROG, participantId: x.participantId, startDate: next.startDate, endDate: next.endDate, minShifts: x.minShifts, maxShifts: x.maxShifts } });
  const lastWeek = await db.scheduledShift.count({ where: { scheduleId: a2.scheduleId, backup: false, participantId: { in: everyone.map((x) => x.participantId) }, dutyDate: { gte: new Date("2027-01-25") } } });
  const hist = ((await compileInterval(next.id)).config as any).history as any[];
  ok(lastWeek > 0 && hist.length === lastWeek, `the next interval's inputs carry the published schedule's last week (${hist.length} shifts, ${lastWeek} expected)`);
  ok(hist.every((h) => h.day < 0 && h.day >= -8), "and they are dated before the new interval starts");
  const stored = new Set((await db.scheduledShift.findMany({ where: { scheduleId: a2.scheduleId, backup: false, participantId: { not: null } } })).map((r) => `${r.participantId}|${r.startsAt.toISOString()}|${r.endsAt.toISOString()}`));
  const at = (h: any, extra = 0) => new Date(next.startDate.getTime() + (h.day * 1440 + toMinutes(h.start) + extra) * 60000).toISOString();
  ok(hist.every((h) => stored.has(`${h.resident}|${at(h)}|${at(h, h.hours * 60)}`)), "each inherited shift is the same person, start and end as a stored shift");
  await unpublish(IV, PROG);
  ok(((await compileInterval(next.id)).config as any).history.length === 0, "after unpublishing, the next interval no longer inherits it");
  ok((await db.interval.findUniqueOrThrow({ where: { id: IV } })).status === "LOCKED" && (await db.schedule.findUniqueOrThrow({ where: { id: a2.scheduleId } })).status === "DRAFT", "unpublishing returns the schedule to a draft and the interval to locked");
  await db.assignment.deleteMany({ where: { startDate: next.startDate } });
  await db.interval.delete({ where: { id: next.id } });
  await db.schedule.deleteMany({ where: { intervalId: IV } });
  await db.timeOff.update({ where: { id: "to7" }, data: { status: "PENDING" } });
  await db.interval.update({ where: { id: IV }, data: { status: "DRAFT", lockedAt: null } });

  // 1c. optimize: starts from an existing schedule, saved as a new draft, never worse on any goal in priority order
  const base = await startRun(IV, null, { seconds: 6, polish: 2 });
  if (!base.ok) throw new Error(base.error);
  ok((await until(base.scheduleId, 120)) === "DONE", "a quick schedule to optimize");
  const opt = await startRun(IV, null, { seconds: 25, polish: 10 }, { scheduleId: base.scheduleId, label: "Run 1" });
  if (!opt.ok) throw new Error(opt.error);
  ok((await until(opt.scheduleId, 150)) === "DONE", "optimizing it finishes");
  const [b0, o1] = await Promise.all([base.scheduleId, opt.scheduleId].map((id) => db.schedule.findUniqueOrThrow({ where: { id } })));
  const score = (x: any) => (x.report.goals as any[]).map((g) => g.score);
  const B = score(b0), O = score(o1);
  const firstDiff = B.findIndex((v, i) => Math.abs(v - O[i]) > 1e-9);
  ok(firstDiff === -1 || O[firstDiff] < B[firstDiff], `the optimized schedule is no worse, goal by goal in priority order (first difference: ${firstDiff === -1 ? "none" : `${(o1.report as any).goals[firstDiff].name} ${B[firstDiff]} -> ${O[firstDiff]}`})`);
  ok(/^Run \d+ \(optimized from Run 1\)$/.test(o1.label ?? "") && b0.status === "DRAFT" && (await db.scheduledShift.count({ where: { scheduleId: base.scheduleId } })) > 0, `it is a new draft (${o1.label}); the original is untouched`);
  await db.schedule.deleteMany({ where: { id: { in: [base.scheduleId, opt.scheduleId] } } });

  // 2. cancel
  const b = await startRun(IV, null, { seconds: 60, polish: 30 });
  if (!b.ok) throw new Error(b.error);
  await sleep(2500);
  const pid = (await db.schedule.findUniqueOrThrow({ where: { id: b.scheduleId } })).workerPid!;
  ok(await cancelRun(b.scheduleId), "a running job can be cancelled");
  await sleep(1500);
  let gone = false; try { process.kill(pid, 0); } catch { gone = true; }
  const cancelled = await db.schedule.findUniqueOrThrow({ where: { id: b.scheduleId }, include: { _count: { select: { shifts: true } } } });
  ok(gone && cancelled.runStatus === "CANCELLED" && cancelled._count.shifts === 0, "cancelling stops the engine process and saves nothing");
  ok((await settleRun(b.scheduleId)) === "CANCELLED", "a cancelled run stays cancelled");
  const no = await publish(b.scheduleId, PROG, true);
  ok(!no.ok && /Only a finished schedule/.test(no.error), "a cancelled run cannot be published, even with the confirmation ticked");

  // 3. the engine crashes: inputs it cannot read
  const bad = await db.schedule.create({ data: { intervalId: IV, source: "SOLVER", runStatus: "RUNNING", startedAt: new Date(), workDir: "/tmp/cadence-no-such-run", workerPid: 2 ** 22 - 3, label: "dead" } });
  ok((await settleRun(bad.id)) === "FAILED", "a run whose process has died without a result is marked failed");
  ok(/stopped before it produced a schedule/.test((await db.schedule.findUniqueOrThrow({ where: { id: bad.id } })).error ?? ""), "and says so in plain words");

  // 3b. the server instance was replaced (a deploy or restart on a hosting service) while the engine was running
  const moved = await db.schedule.create({ data: { intervalId: IV, source: "SOLVER", runStatus: "RUNNING", startedAt: new Date(), workDir: "/tmp/cadence-no-such-run", workerPid: process.pid, workerHost: "an-instance-that-no-longer-exists", label: "moved" } });
  ok((await settleRun(moved.id)) === "FAILED" && /server was restarted while the engine was running/.test((await db.schedule.findUniqueOrThrow({ where: { id: moved.id } })).error ?? ""),
    "a run that belonged to a server instance since replaced is marked lost at once, with the reason");

  // 4. python missing
  process.env.ENGINE_PYTHON = "/no/such/python";
  const d = await startRun(IV, null, { seconds: 5, polish: 1 });
  ok(!d.ok && /Python was not found/.test(d.error), "a missing Python is reported when starting");
  delete process.env.ENGINE_PYTHON;

  // 5. engine folder missing
  process.env.ENGINE_DIR = "/no/such/folder";
  const e = await startRun(IV, null, { seconds: 5, polish: 1 });
  ok(!e.ok && /was not found on this server/.test(e.error), "a missing engine folder is reported when starting");
  delete process.env.ENGINE_DIR;
  ok((await db.schedule.count({ where: { intervalId: IV, runStatus: { in: ["QUEUED", "RUNNING"] } } })) === 0, "no run is left marked as in progress");

  // 6. the engine itself stops with an error: the reason and its output are kept, and nothing is saved
  const fake = mkdtempSync(join(tmpdir(), "cadence-fake-engine-"));
  writeFileSync(join(fake, "run.py"), 'print("starting")\nassert False, "unknown category Twilight"\n');
  process.env.ENGINE_DIR = fake;
  const f = await startRun(IV, null, { seconds: 5, polish: 1 });
  delete process.env.ENGINE_DIR;
  ok(f.ok, "another run can start once nothing is in progress");
  if (f.ok) {
    const st2 = await until(f.scheduleId, 20);
    const row = await db.schedule.findUniqueOrThrow({ where: { id: f.scheduleId }, include: { _count: { select: { shifts: true } } } });
    ok(st2 === "FAILED" && row._count.shifts === 0, "an engine that stops with an error gives a failed run with no shifts saved");
    ok(/rejected the inputs: unknown category Twilight/.test(row.error ?? ""), `the reason is given in plain words ("${row.error}")`);
    ok(/starting/.test((row.report as any)?.log ?? ""), "the engine's own output is kept as technical detail");
  }
  rmSync(fake, { recursive: true, force: true });

  console.log(failed ? `\n${failed} FAILED` : "\nENGINE RUNNER CHECKS PASSED");
  await db.schedule.deleteMany({ where: { intervalId: IV } });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
