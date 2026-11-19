// Rules about publishing a schedule, shared by the review page (to explain) and the publish action (to enforce).
import { db } from "./db";
import { compileInterval } from "./compile";
import { COMPILER_VERSION, fingerprint } from "./engine";

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
  // institutions: a clinical shift must be at an institution the person is assigned to for that day (no institutions
  // ticked means all of them), inside any "only from / until" dates set for it
  const sch = await db.schedule.findUniqueOrThrow({ where: { id: sid }, select: { interval: { select: { startDate: true, endDate: true } } } });
  const asg = await db.assignment.findMany({ where: { participantId: { in: [...new Set(rows.map((r) => r.participantId!))] }, startDate: { lte: sch.interval.endDate }, endDate: { gte: sch.interval.startDate } },
    include: { institutions: { include: { institution: true } } } });
  const placeProblem = (pid: string, instId: string, duty: Date, d: Date): string | null => {
    const mine = asg.filter((a) => a.participantId === pid && a.startDate <= duty && duty <= a.endDate);
    if (!mine.length) return "is not assigned to the interval on that day";
    if (mine.some((a) => !a.institutions.length)) return null;
    const at = mine.flatMap((a) => a.institutions).filter((i) => i.institutionId === instId);
    if (!at.length) return `is assigned only to ${[...new Set(mine.flatMap((a) => a.institutions.map((i) => i.institution.name)))].join(" and ")} in this interval`;
    return at.some((i) => (!i.startDate || i.startDate <= d) && (!i.endDate || d <= i.endDate)) ? null : `is outside the dates set for ${at[0].institution.name}`;
  };
  const instName = new Map((await db.institution.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.institutionId))] } } })).map((i) => [i.id, i.name]));

  // what the engine was actually told, from the inputs stored with the run: settles whether a mismatch came from the
  // inputs (an older version, or the grid / the person's role changed since) or from the engine itself
  type Cfg = { _compiler?: string; residents?: { id: string; pgy: number; only_shifts?: string[] }[]; shift_templates?: { ref?: string; min_pgy?: number }[];
    backup?: { ref?: string; eligible?: string[] }[] };
  const cfg = ((await db.schedule.findUnique({ where: { id: sid }, select: { inputSnapshot: true } }))?.inputSnapshot ?? {}) as Cfg;
  const told = new Map((cfg.residents ?? []).map((x) => [x.id, x]));
  const old = !cfg._compiler || cfg._compiler < COMPILER_VERSION;           // built before the current checks were sent to the engine
  const toldAllowed = (pid: string, gid: string, backup: boolean): boolean | null => {
    if (backup) { const b = (cfg.backup ?? []).find((x) => x.ref === gid); return b ? (b.eligible ?? []).includes(pid) : null; }
    const r = told.get(pid);
    if (!r) return null;
    if (r.only_shifts) return r.only_shifts.includes(gid);
    const mins = (cfg.shift_templates ?? []).filter((t) => t.ref === gid).map((t) => t.min_pgy ?? 1);
    return mins.length ? r.pgy >= Math.min(...mins) : null;
  };
  const out: string[] = [];
  const why = new Map<string, string>();
  for (const r of rows) {
    const p = r.participant!, gid = r.shiftId ?? r.specialShift?.shiftId ?? null;
    const when = `${r.name}${r.backup ? " (backup)" : ""} on ${r.dutyDate.toISOString().slice(0, 10)}`;
    if (!r.backup) {
      const startDay = new Date(Date.UTC(r.startsAt.getUTCFullYear(), r.startsAt.getUTCMonth(), r.startsAt.getUTCDate()));   // as the engine does: the date a shift starts on
      const where = placeProblem(p.id, r.institutionId, r.dutyDate, startDay);
      if (where) { out.push(`Institution: ${p.firstName} ${p.lastName} is on ${when} at ${instName.get(r.institutionId) ?? "an institution"}, but ${where}.`); why.set(old ? "old" : "unknown", ""); }
    }
    if (!gid) { out.push(`Role grid: ${p.firstName} ${p.lastName} is on ${when}, which has no role grid (a special-day shift that copies no normal shift).`); continue; }
    if (grid.get(gid + "|" + p.roleId) !== false) continue;
    out.push(`Role grid: ${p.firstName} ${p.lastName} (${p.role.name}) is on ${when}, but ${p.role.name} is not eligible for it.`);
    const t = toldAllowed(p.id, gid, r.backup);
    why.set(t === false ? "engine" : old ? "old" : t ? "changed" : "unknown", "");
  }
  if (why.has("old")) out.push("Cause: this schedule was generated by an earlier version of the site, before each person's role grid and institutions were sent to the engine as a list of allowed shifts (18 Nov 2026). Generate it again.");
  if (why.has("changed")) out.push("Cause: when this schedule was generated, its inputs allowed these shifts; a role grid or a person's role has changed since. Generate it again.");
  if (why.has("engine")) out.push("Cause: the engine was told these shifts were not allowed and scheduled them anyway. That is a fault in the engine: please report it with this schedule.");
  return out;
}

export async function publishChecks(sid: string, programId: string) {
  const sch = await db.schedule.findFirst({ where: { id: sid, interval: { programId } }, include: { interval: true } });
  if (!sch) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rep = sch.report as any;
  const grid = sch.runStatus === "DONE" ? await eligibilityProblems(sid) : [];
  const violations: string[] = [...(rep?.validator?.hard_violations ?? []), ...grid.filter((v) => !v.startsWith("Cause: "))];
  const causes = grid.filter((v) => v.startsWith("Cause: ")).map((v) => v.slice(7));
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
  return { sch, violations, causes, open, backupOpen, stale, blocked, caveats };
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
