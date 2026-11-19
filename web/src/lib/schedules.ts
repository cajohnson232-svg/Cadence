// Rules about publishing a schedule, shared by the review page (to explain) and the publish action (to enforce).
import { db } from "./db";
import { compileInterval } from "./compile";
import { fingerprint } from "./engine";

/**
 * What stands between a schedule and publishing it.
 *   blocked   cannot be published at all (not finished, or it breaks a hard rule)
 *   caveats   can be published, but only with an explicit tick (open shifts, or inputs changed since it was generated)
 */
/** Every stored shift checked against the role grid as it is now, independently of the engine: a person may only be on
 *  a shift (or a backup day) their role is eligible for. A special-day shift uses the grid of the shift it copies. */
export async function eligibilityProblems(sid: string): Promise<string[]> {
  const rows = await db.scheduledShift.findMany({ where: { scheduleId: sid, participantId: { not: null } },
    include: { participant: { include: { role: true } }, specialShift: true }, orderBy: [{ startsAt: "asc" }, { id: "asc" }] });
  const gridIds = [...new Set(rows.map((r) => r.shiftId ?? r.specialShift?.shiftId).filter((x): x is string => !!x))];
  const grid = new Map((await db.shiftRole.findMany({ where: { shiftId: { in: gridIds } } })).map((g) => [g.shiftId + "|" + g.roleId, g.eligible]));
  const out: string[] = [];
  for (const r of rows) {
    const p = r.participant!, gid = r.shiftId ?? r.specialShift?.shiftId ?? null;
    const when = `${r.name}${r.backup ? " (backup)" : ""} on ${r.dutyDate.toISOString().slice(0, 10)}`;
    if (!gid) out.push(`Role grid: ${p.firstName} ${p.lastName} is on ${when}, which has no role grid (a special-day shift that copies no normal shift).`);
    else if (grid.get(gid + "|" + p.roleId) === false) out.push(`Role grid: ${p.firstName} ${p.lastName} (${p.role.name}) is on ${when}, but ${p.role.name} is not eligible for it.`);
  }
  return out;
}

export async function publishChecks(sid: string, programId: string) {
  const sch = await db.schedule.findFirst({ where: { id: sid, interval: { programId } }, include: { interval: true } });
  if (!sch) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rep = sch.report as any;
  const violations: string[] = [...(rep?.validator?.hard_violations ?? []), ...(sch.runStatus === "DONE" ? await eligibilityProblems(sid) : [])];
  const open = await db.scheduledShift.count({ where: { scheduleId: sid, participantId: null, backup: false } });
  const backupOpen = await db.scheduledShift.count({ where: { scheduleId: sid, participantId: null, backup: true } });
  const stale = !!sch.inputHash && sch.inputHash !== fingerprint((await compileInterval(sch.intervalId)).config);
  const blocked = sch.runStatus !== "DONE" ? "Only a finished schedule can be published."
    : violations.length ? `This schedule breaks ${violations.length} hard rule${violations.length === 1 ? "" : "s"} and cannot be published.` : null;
  const caveats = [
    ...(open ? [`${open} shift${open === 1 ? " is" : "s are"} still open`] : []),
    ...(backupOpen ? [`${backupOpen} backup day${backupOpen === 1 ? " has" : "s have"} nobody on backup`] : []),
    ...(stale ? ["the inputs have changed since it was generated"] : []),
  ];
  return { sch, violations, open, backupOpen, stale, blocked, caveats };
}

export type PublishResult = { ok: true; intervalName: string; open: number; stale: boolean } | { ok: false; error: string };

/** Publish a schedule: it replaces whatever is published for the interval, and the interval becomes published. */
export async function publish(sid: string, programId: string, confirmed: boolean): Promise<PublishResult> {
  const c = await publishChecks(sid, programId);
  if (!c) return { ok: false, error: "That schedule does not exist." };
  if (c.blocked) return { ok: false, error: c.blocked };
  if (c.caveats.length && !confirmed) return { ok: false, error: `Not published: ${c.caveats.join(", and ")}. Tick the box to publish anyway.` };
  const now = new Date(), intervalId = c.sch.intervalId;
  await db.$transaction([
    db.schedule.updateMany({ where: { intervalId, status: "PUBLISHED", id: { not: sid } }, data: { status: "SUPERSEDED" } }),
    db.schedule.update({ where: { id: sid }, data: { status: "PUBLISHED", publishedAt: now } }),
    db.interval.update({ where: { id: intervalId }, data: { status: "PUBLISHED", publishedAt: now, lockedAt: c.sch.interval.lockedAt ?? now } }),
  ]);
  return { ok: true, intervalName: c.sch.interval.name, open: c.open, stale: c.stale };
}

/** Take an interval's published schedule back to a draft. The interval stays locked. Returns the schedule's id, if there was one. */
export async function unpublish(intervalId: string, programId: string): Promise<string | null> {
  const iv = await db.interval.findFirst({ where: { id: intervalId, programId } });
  if (!iv) return null;
  const pub = await db.schedule.findFirst({ where: { intervalId, status: "PUBLISHED" } });
  await db.$transaction([
    db.schedule.updateMany({ where: { intervalId, status: "PUBLISHED" }, data: { status: "DRAFT", publishedAt: null } }),
    db.interval.update({ where: { id: intervalId }, data: { status: "LOCKED", publishedAt: null } }),
  ]);
  return pub?.id ?? null;
}
