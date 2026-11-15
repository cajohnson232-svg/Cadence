// Scheduling-domain helpers shared by the forms, the lists and the interval hub.
import { db } from "./db";
import { addDays, dayDiff, dow, eachDay, fmtShort, hhmm, overlaps, ymd } from "./util";
import type { Row } from "./crud";

export type AcademicSession = {
  academicDayId: string; name: string; date: Date; startMinute: number; durationMinutes: number;
  policy: "BLOCKED" | "EXCUSED"; protectBefore: number; protectAfter: number;
  roleIds: string[]; excused: string[]; also: string[];
};

/** A recurring academic day expanded to dated sessions, with one-week changes and cancellations applied. */
export async function academicSessions(programId: string, from: Date, to: Date): Promise<AcademicSession[]> {
  const series = await db.academicDay.findMany({
    where: { programId, active: true, archivedAt: null },
    include: { roles: true, occurrences: true, exceptions: true },
    orderBy: { id: "asc" },
  });
  const out: AcademicSession[] = [];
  for (const a of series) {
    const occ = new Map(a.occurrences.map((o) => [ymd(o.date), o]));
    for (const d of eachDay(from, to)) {
      if (dow(d) !== a.dayOfWeek || (a.startDate && d < a.startDate) || (a.endDate && d > a.endDate)) continue;
      const o = occ.get(ymd(d));
      if (o?.cancelled) continue;
      const covers = (e: { startDate: Date | null; endDate: Date | null }) => (!e.startDate || e.startDate <= d) && (!e.endDate || d <= e.endDate);
      out.push({
        academicDayId: a.id, name: a.name, date: d,
        startMinute: o?.startMinute ?? a.startMinute, durationMinutes: o?.durationMinutes ?? a.durationMinutes,
        policy: o?.overlapPolicy ?? a.overlapPolicy, protectBefore: a.protectBeforeMinutes, protectAfter: a.protectAfterMinutes,
        roleIds: a.roles.map((r) => r.roleId),
        excused: a.exceptions.filter((e) => e.type === "EXCUSED" && covers(e)).map((e) => e.participantId),
        also: a.exceptions.filter((e) => e.type === "REQUIRED" && covers(e)).map((e) => e.participantId),
      });
    }
  }
  return out;
}

export const attends = (s: AcademicSession, p: { id: string; roleId: string }) =>
  !s.excused.includes(p.id) && (s.roleIds.length === 0 || s.roleIds.includes(p.roleId) || s.also.includes(p.id));

export const sessionLabel = (s: AcademicSession) =>
  `${s.name} ${fmtShort(s.date)} ${hhmm(s.startMinute)}–${hhmm(s.startMinute + s.durationMinutes)}`;

/** Requests off are counted per DAY requested. */
export const requestDays = (t: { startDate: Date; endDate: Date }) => dayDiff(t.startDate, t.endDate) + 1;

export async function allowance(intervalId: string) {
  const iv = await db.interval.findUniqueOrThrow({ where: { id: intervalId }, include: { program: true } });
  return {
    interval: iv,
    days: iv.requestAllowance ?? iv.program.defaultRequestAllowance,
    high: iv.highPriorityAllowance ?? iv.program.defaultHighPriorityAllowance,
  };
}

/** Days of requests off already used in an interval (pending and approved count; denied do not). */
export async function requestUsage(intervalId: string, participantId: string, excludeId?: string | null) {
  const rows = await db.timeOff.findMany({
    where: { intervalId, participantId, kind: "REQUEST_OFF", status: { not: "DENIED" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  return {
    days: rows.reduce((n, t) => n + requestDays(t), 0),
    high: rows.filter((t) => t.priority === "HIGH").reduce((n, t) => n + requestDays(t), 0),
  };
}

/** Things an admin should see next to a time-off row: clashes that are allowed but worth knowing about. */
export async function timeOffConflicts(programId: string, rows: Row[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!rows.length) return out;
  const from = new Date(Math.min(...rows.map((r) => r.startDate.getTime())));
  const to = new Date(Math.max(...rows.map((r) => r.endDate.getTime())));
  const pids = [...new Set(rows.map((r) => r.participantId))];
  const [sessions, special, assignments, people, others] = await Promise.all([
    academicSessions(programId, from, to),
    db.specialStaffingDay.findMany({ where: { programId, date: { gte: from, lte: to } }, include: { institution: true } }),
    db.assignment.findMany({ where: { participantId: { in: pids } }, include: { institutions: true } }),
    db.participant.findMany({ where: { id: { in: pids } } }),
    db.timeOff.findMany({ where: { participantId: { in: pids }, status: { not: "DENIED" }, startDate: { lte: to }, endDate: { gte: from } } }),
  ]);
  const person = new Map(people.map((p) => [p.id, p]));
  for (const r of rows) {
    const notes: string[] = [];
    const p = person.get(r.participantId);
    const mine = assignments.filter((a) => a.participantId === r.participantId);
    const uncovered = eachDay(r.startDate, r.endDate).filter((d) => !mine.some((a) => a.startDate <= d && d <= a.endDate));
    if (uncovered.length) notes.push(`No assignment covers ${fmtShort(uncovered[0])}${uncovered.length > 1 ? ` (+${uncovered.length - 1} more day(s))` : ""}`);
    if (p) for (const s of sessions) if (r.startDate <= s.date && s.date <= r.endDate && attends(s, p)) notes.push(`Misses ${sessionLabel(s)}`);
    const sites = new Set(mine.flatMap((a) => a.institutions.map((i) => i.institutionId)));
    for (const sd of special)
      if (r.startDate <= sd.date && sd.date <= r.endDate && (sites.size === 0 || sites.has(sd.institutionId)))
        notes.push(`Falls on a special staffing day: ${sd.name} (${sd.institution.shortCode}, ${fmtShort(sd.date)})`);
    for (const o of others)
      if (o.id !== r.id && o.participantId === r.participantId && overlaps(o.startDate, o.endDate, r.startDate, r.endDate))
        notes.push(`Overlaps their ${o.kind === "VACATION" ? "vacation" : "request"} ${fmtShort(o.startDate)}–${fmtShort(o.endDate)}`);
    if (r.interval?.requestDeadline && r.kind !== "VACATION" && r.createdAt > r.interval.requestDeadline) notes.push("Submitted after the request deadline");
    out.set(r.id, notes);
  }
  return out;
}

export const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
export { addDays };
