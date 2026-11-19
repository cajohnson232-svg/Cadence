// Running the scheduling engine from the app.
//
//   startRun(intervalId, userId, budget)   compile the interval, start the engine in the background
//   settleRun(scheduleId)                  if the engine has finished, import its result (or record why it failed)
//   cancelRun(scheduleId)                  stop a run
//   runProgress(schedule)                  what the engine is doing right now
//
// The engine is the Python program in ENGINE_DIR (the folder that holds run.py). It is started as
// a separate process: it reads one JSON file (the compiled inputs) and writes one JSON file (the
// result), so the app and the engine share no code and no database access.
//
// State lives in the Schedule row and in the run's work folder, never in this server's memory, so a
// run survives a restart of the web server and any request can finish the import.
//
// This file is the one place to change when the engine moves to its own service or a job queue:
// keep the three functions above, replace the process handling inside them.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "./db";
import { compileInterval } from "./compile";
import { addDays } from "./util";
import { categoryKeys, invert, siteKeys } from "./engine-keys";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const BUDGETS = {
  quick: { label: "Quick", hint: "about 1 minute", seconds: 40, polish: 15 },
  standard: { label: "Standard", hint: "about 5 minutes", seconds: 240, polish: 60 },
  thorough: { label: "Thorough", hint: "about 15 minutes", seconds: 780, polish: 120 },
} as const;
export type Budget = keyof typeof BUDGETS;

// The engine is a separate program outside this app's bundle; the comments below tell the bundler not to try to package it.
const engineDir = () => resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.ENGINE_DIR || "..");
const python = () => process.env.ENGINE_PYTHON || "python3";
// one work folder per operating-system user, so a folder left behind by a different user can never be in the way
const workRoot = () => process.env.ENGINE_WORK_DIR || join(tmpdir(), `cadence-runs-${process.getuid?.() ?? "app"}`);
const ACTIVE = ["QUEUED", "RUNNING"] as const;

/** The same inputs always give the same fingerprint, whatever order the database returned rows in. */
export function fingerprint(config: unknown): string {
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      const items = x.map(canon);
      const records = items.length > 0 && items.every((i) => i && typeof i === "object" && !Array.isArray(i));
      return records ? items.map((i) => JSON.stringify(i)).sort().map((s) => JSON.parse(s)) : items;
    }
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Any)[k])]));
    return x;
  };
  return createHash("sha256").update(JSON.stringify(canon(config))).digest("hex");
}

export type StartResult = { ok: true; scheduleId: string } | { ok: false; error: string };

/** Independent check, before every run: for every person and every shift template the engine will see, is the person
 *  allowed on it exactly when the role grid and the person's institutions say so? Written from the database, not from
 *  the compile step, so a slip in compiling can never reach the engine. Returns the pairs that differ. */
export async function eligibilityMismatches(intervalId: string, cfg: Any): Promise<string[]> {
  const iv = await db.interval.findUniqueOrThrow({ where: { id: intervalId } });
  const [shifts, grid, asg, people] = await Promise.all([
    db.shift.findMany({ where: { programId: iv.programId } }),
    db.shiftRole.findMany({ where: { shift: { programId: iv.programId } } }),
    db.assignment.findMany({ where: { participant: { programId: iv.programId }, startDate: { lte: iv.endDate }, endDate: { gte: iv.startDate } }, include: { institutions: true } }),
    db.participant.findMany({ where: { programId: iv.programId } }),
  ]);
  const instOf = new Map(shifts.map((x) => [x.id, x.institutionId])), nameOf = new Map(shifts.map((x) => [x.id, x.name]));
  const g = new Map(grid.map((x) => [x.shiftId + "|" + x.roleId, x.eligible]));
  const role = new Map(people.map((x) => [x.id, x.roleId])), who = new Map(people.map((x) => [x.id, `${x.firstName} ${x.lastName}`]));
  const out: string[] = [];
  for (const r of (cfg.residents ?? []) as Any[]) {
    const mine = asg.filter((a) => a.participantId === r.id);
    const places = mine.some((a) => !a.institutions.length) ? null : new Set(mine.flatMap((a) => a.institutions.map((i) => i.institutionId)));
    for (const t of (cfg.shift_templates ?? []) as Any[]) {
      const told = r.only_shifts ? r.only_shifts.includes(t.ref) : r.pgy >= (t.min_pgy ?? 1);
      if (!told) continue;                                             // refusing more than the grid would is never unsafe
      const inst = instOf.get(t.ref);
      const ok = !!inst && (g.get(t.ref + "|" + role.get(r.id)) ?? true) && (!places || places.has(inst));
      if (!ok) out.push(`${who.get(r.id) ?? r.id} on ${nameOf.get(t.ref) ?? t.name}`);
    }
  }
  return [...new Set(out)];
}

/** Stored with each run's inputs (not part of the fingerprint): which version of the compile step built them. */
export const COMPILER_VERSION = "2026-11-18b";

export async function startRun(intervalId: string, userId: string | null, budget: Budget | { seconds: number; polish: number },
  from?: { scheduleId: string; label: string }): Promise<StartResult> {
  const b = typeof budget === "string" ? BUDGETS[budget] ?? BUDGETS.standard : budget;
  const dirE = engineDir();
  if (!existsSync(join(dirE, "run.py")))
    return { ok: false, error: `The scheduling engine was not found on this server (looked for run.py in ${dirE}). Set ENGINE_DIR.` };

  const c = await compileInterval(intervalId);
  const wrong = await eligibilityMismatches(intervalId, c.config);
  if (wrong.length) return { ok: false, error: `Not started: the inputs would let ${wrong.length} person-and-shift pair(s) through that the role grid or the institutions forbid, e.g. ${wrong.slice(0, 3).join("; ")}. Please report this.` };
  const cfg = c.config as Any;
  if (!cfg.residents.length) return { ok: false, error: "Nobody is assigned to this interval yet. Add assignments first." };
  if (!cfg.shift_templates.length) return { ok: false, error: "There are no shifts to fill. Add shifts first." };

  // "Run 4" follows the highest run number still listed, so two schedules never share a name
  const labels = await db.schedule.findMany({ where: { intervalId }, select: { label: true } });
  const n = Math.max(0, ...labels.map((l) => Number(/^Run (\d+)$/.exec(l.label ?? "")?.[1] ?? 0)));
  let sch;
  try {
    sch = await db.schedule.create({
      data: { intervalId, source: "SOLVER", status: "DRAFT", runStatus: "QUEUED", label: from ? `Run ${n + 1} (optimized from ${from.label})` : `Run ${n + 1}`, createdById: userId,
        inputSnapshot: { ...cfg, _compiler: COMPILER_VERSION }, inputHash: fingerprint(cfg), timeBudget: b.seconds + b.polish },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, error: "A schedule is already being generated for this interval." };
    throw e;
  }

  const dir = join(workRoot(), sch.id);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    const extra: string[] = [];
    if (from) {          // the schedule to start from: each person's clinical shifts, as day + name + clock times
      const start0 = (await db.interval.findUniqueOrThrow({ where: { id: intervalId } })).startDate.getTime();
      const rows = await db.scheduledShift.findMany({ where: { scheduleId: from.scheduleId, participantId: { not: null }, backup: false } });
      const min = (d: Date) => Math.round((d.getTime() - start0) / 60000);
      writeFileSync(join(dir, "initial.json"), JSON.stringify(rows.map((r) => ({ resident: r.participantId, ref: r.shiftId ?? undefined, day: Math.round((r.dutyDate.getTime() - start0) / 86400000), name: r.name, start: min(r.startsAt), end: min(r.endsAt) }))));
      extra.push("--initial", join(dir, "initial.json"));
    }
    const log = openSync(join(dir, "engine.log"), "a");
    const child = spawn(/*turbopackIgnore: true*/ python(), ["-u", "run.py", join(dir, "config.json"), "--out", dir, "--result", join(dir, "result.json"),
      "--progress", join(dir, "progress.json"), "--seconds", String(b.seconds), "--polish-seconds", String(b.polish),
      "--backend", process.env.ENGINE_BACKEND || "auto", ...extra], { cwd: dirE, detached: true, stdio: ["ignore", log, log] });
    await new Promise<void>((ok, bad) => { child.once("spawn", () => ok()); child.once("error", bad); });
    closeSync(log);
    child.once("exit", () => { settleRun(sch.id).catch(() => {}); });
    child.unref();
    await db.schedule.updateMany({ where: { id: sch.id, runStatus: "QUEUED" }, data: { runStatus: "RUNNING", startedAt: new Date(), workDir: dir, workerPid: child.pid, workerHost: hostname() } });
  } catch (e) {
    const missing = (e as { code?: string }).code === "ENOENT";
    const error = missing ? `Python was not found on this server ("${python()}"). Set ENGINE_PYTHON.` : `The scheduling engine could not be started: ${(e as Error).message}`;
    await db.schedule.update({ where: { id: sch.id }, data: { runStatus: "FAILED", finishedAt: new Date(), error } });
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error };
  }
  return { ok: true, scheduleId: sch.id };
}

const alive = (pid: number | null) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
};
const stop = (pid: number | null) => {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* not a group leader, or already gone */ }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
};
const logTail = (dir: string | null, lines = 25) => {
  try { return readFileSync(join(dir!, "engine.log"), "utf8").replace(/\r/g, "\n").split("\n").filter((l) => l.trim()).slice(-lines).join("\n"); } catch { return ""; }
};

/** Why a run stopped, in words an admin can act on. The engine's own output is kept separately as technical detail. */
function explainFailure(tail: string): string {
  if (/No module named '(numpy|scipy)'/.test(tail)) return "The engine's Python packages are not installed on this server (NumPy and SciPy are required).";
  if (/No module named/.test(tail)) return "The engine could not load one of its Python modules. See the technical details.";
  if (/MemoryError|Killed/.test(tail)) return "The engine ran out of memory.";
  const assertion = /AssertionError: (.+)/.exec(tail);
  if (assertion) return `The engine rejected the inputs: ${assertion[1]}.`;
  if (/Traceback/.test(tail)) return "The engine stopped with an internal error before it produced a schedule. Nothing was saved.";
  return "The engine stopped before it produced a schedule. Nothing was saved.";
}

async function fail(id: string, dir: string | null, error: string) {
  const tail = logTail(dir);
  const done = await db.schedule.updateMany({ where: { id, runStatus: { in: [...ACTIVE] } }, data: { runStatus: "FAILED", finishedAt: new Date(), error, workerPid: null, report: { log: tail } } });
  if (done.count && dir) rmSync(dir, { recursive: true, force: true });
}

/** Bring one run up to date. Safe to call from anywhere, any number of times. Returns the run status afterwards. */
export async function settleRun(id: string): Promise<string | null> {
  const sch = await db.schedule.findUnique({ where: { id }, include: { interval: true } });
  if (!sch) return null;
  if (sch.runStatus !== "RUNNING" && sch.runStatus !== "QUEUED") return sch.runStatus;
  if (sch.runStatus === "QUEUED") {
    // still being started by another request; if that request died, give up after a short while
    if (Date.now() - sch.createdAt.getTime() < 30_000) return "QUEUED";
    await fail(id, null, "The engine was never started. Please try again.");
    return "FAILED";
  }
  const dir = sch.workDir!;
  // A hosting service replaces the server instance on every deploy or restart, and the engine process and its
  // files go with it. (This assumes one instance; with several, the engine must move to its own service.)
  if (sch.workerHost && sch.workerHost !== hostname()) {
    await fail(id, null, "The server was restarted while the engine was running, so this run was lost. Nothing was saved. Generate again.");
    return "FAILED";
  }
  const running = alive(sch.workerPid);          // checked BEFORE looking for the result: the engine writes its result, then exits
  const resultPath = join(dir, "result.json");
  if (existsSync(resultPath)) {
    let result: Any;
    try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch { await fail(id, dir, "The engine's result could not be read. Nothing was saved."); return "FAILED"; }
    return importResult(sch, result);
  }
  if (!running) { await fail(id, dir, explainFailure(logTail(dir))); return "FAILED"; }
  const allowed = ((sch.timeBudget ?? 300) * 3 + 180) * 1000;
  if (sch.startedAt && Date.now() - sch.startedAt.getTime() > allowed) {
    stop(sch.workerPid);
    await fail(id, dir, "The engine ran far longer than the time it was given and was stopped. Nothing was saved.");
    return "FAILED";
  }
  return "RUNNING";
}

/** Settle whatever is in progress for an interval (used when a page is opened). */
export async function settleInterval(intervalId: string) {
  const active = await db.schedule.findMany({ where: { intervalId, runStatus: { in: [...ACTIVE] } }, select: { id: true } });
  for (const a of active) await settleRun(a.id);
}

async function importResult(sch: Any, result: Any): Promise<string> {
  const pid = sch.interval.programId, start: Date = sch.interval.startDate;
  const [insts, cats, shifts, special, people] = await Promise.all([
    db.institution.findMany({ where: { programId: pid } }),
    db.shiftCategory.findMany({ where: { programId: pid } }),
    db.shift.findMany({ where: { programId: pid }, select: { id: true } }),
    db.specialStaffingShift.findMany({ where: { day: { programId: pid } }, select: { id: true } }),
    db.participant.findMany({ where: { programId: pid }, select: { id: true } }),
  ]);
  const inst = invert(siteKeys(insts)), cat = invert(categoryKeys(cats));      // the same unique keys the compile step sent
  const shiftIds = new Set(shifts.map((s) => s.id)), specialIds = new Set(special.map((s) => s.id)), personIds = new Set(people.map((p) => p.id));
  const at = (m: number) => new Date(start.getTime() + m * 60000);
  const rows: Any[] = [];
  const problems = new Set<string>();
  for (const s of result.slots as Any[]) {
    const institutionId = inst.get(s.site), categoryId = cat.get(s.category);
    if (!institutionId) problems.add(`institution "${s.site}"`);
    if (!categoryId) problems.add(`shift category "${s.category}"`);
    for (const p of s.assigned as string[]) if (!personIds.has(p)) problems.add(`participant ${p}`);
    if (s.assigned.length > s.need) problems.add(`${s.name}: more people than needed`);
    const names: (string | null)[] = [...s.assigned, ...Array(Math.max(0, s.need - s.assigned.length)).fill(null)];
    for (const participantId of names)
      rows.push({ scheduleId: sch.id, participantId, institutionId, categoryId, shiftId: shiftIds.has(s.ref) ? s.ref : null,
        specialStaffingShiftId: s.special_ref && specialIds.has(s.special_ref) ? s.special_ref : null, name: s.name,
        dutyDate: addDays(start, s.day), startsAt: at(s.start), endsAt: at(s.end) });
  }
  for (const e of (result.backup?.days ?? []) as Any[]) {     // backup (on-call) days: rows marked backup, open ones without a person
    const institutionId = inst.get(e.site), categoryId = cat.get(e.category);
    if (!institutionId || !categoryId) { problems.add(`backup shift "${e.name}"`); continue; }
    const names: (string | null)[] = [...e.assigned, ...Array(Math.max(0, e.need - e.assigned.length)).fill(null)];
    for (const participantId of names)
      rows.push({ scheduleId: sch.id, participantId, institutionId, categoryId, shiftId: shiftIds.has(e.ref) ? e.ref : null, specialStaffingShiftId: null,
        name: e.name, dutyDate: addDays(start, e.day), startsAt: at(e.start), endsAt: at(e.end), backup: true });
  }
  if (problems.size) {
    await fail(sch.id, sch.workDir, `The program's setup changed while the engine was running (${[...problems].slice(0, 3).join(", ")} no longer exists). Generate again.`);
    return "FAILED";
  }
  const { slots: _slots, ...report } = result;
  void _slots;
  const imported = await db.$transaction(async (tx) => {
    const claim = await tx.schedule.updateMany({ where: { id: sch.id, runStatus: { in: [...ACTIVE] } }, data: { runStatus: "DONE", finishedAt: new Date(), workerPid: null, report } });
    if (!claim.count) return false;                       // another request imported it, or it was cancelled
    await tx.scheduledShift.createMany({ data: rows });
    return true;
  });
  if (imported && sch.workDir) rmSync(sch.workDir, { recursive: true, force: true });
  return (await db.schedule.findUnique({ where: { id: sch.id }, select: { runStatus: true } }))?.runStatus ?? "DONE";
}

export async function cancelRun(id: string): Promise<boolean> {
  const sch = await db.schedule.findUnique({ where: { id } });
  if (!sch || (sch.runStatus !== "RUNNING" && sch.runStatus !== "QUEUED")) return false;
  const done = await db.schedule.updateMany({ where: { id, runStatus: { in: [...ACTIVE] } }, data: { runStatus: "CANCELLED", finishedAt: new Date(), workerPid: null } });
  if (!done.count) return false;
  stop(sch.workerPid);
  if (sch.workDir) rmSync(sch.workDir, { recursive: true, force: true });
  return true;
}

const GOAL: Record<string, string> = {
  "open shifts": "filling open shifts", "contract shortfall": "contract minimums", "backward rotations": "forward rotation",
  "day/evening/night balance": "balance across shift types", "night runs too close": "spacing between runs of nights",
  "nights into vacation": "nights before vacation", "night share over limit": "share of nights", "pod balance": "balance between areas",
  "isolated days off": "keeping days off together", "extra / over-long night runs": "runs of nights", "requests off missed": "requests off",
};
const PHASE: Record<string, string> = {
  reading: "Reading the inputs", backup: "Choosing who is on backup", "capacity check": "Checking there are enough people for the shifts", "first schedule": "Building a first schedule",
  swaps: "Improving it with swaps", "rule check": "Checking every rule independently", done: "Saving the schedule",
};

/** What a run is doing right now, for the progress display. */
export function runProgress(sch: { runStatus: string; workDir: string | null; startedAt: Date | null; createdAt: Date; timeBudget: number | null }) {
  let p: Any = null;
  if (sch.workDir) try { p = JSON.parse(readFileSync(join(sch.workDir, "progress.json"), "utf8")); } catch { /* not written yet */ }
  const phase = p?.phase === "goal" ? `Working on ${GOAL[p.goal] ?? p.goal}` : PHASE[p?.phase] ?? "Starting the engine";
  return {
    status: sch.runStatus, phase, open: typeof p?.open === "number" ? (p.open as number) : null,
    elapsed: Math.max(0, Math.round((Date.now() - (sch.startedAt ?? sch.createdAt).getTime()) / 1000)), budget: sch.timeBudget ?? 0,
  };
}
