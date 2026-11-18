"use server";
// The participant's assignment page: everything about one person in one interval.
// Every action checks who is asking, that the participant and interval belong to the program,
// and answers by sending the browser back to the page with a message.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { overlaps, parseYmd, toMinutes } from "@/lib/util";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const page = (pid: string, iv: string) => `/assignments/${pid}?interval=${iv}`;
const back = (pid: string, iv: string, kind: "notice" | "error", text: string, anchor = ""): never =>
  redirect(`${page(pid, iv)}&${kind}=${encodeURIComponent(text)}${anchor ? `#${anchor}` : ""}`);
const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? parseYmd(v) : null);
const minutes = (v: string) => { if (!/^\d{1,2}:\d{2}$/.test(v)) return null; const m = toMinutes(v); return m >= 0 && m < 1440 ? m : null; };

/** The participant and interval, both checked to belong to the signed-in program, and this person's assignment for it (if any). */
async function scope(pid: string, iv: string) {
  const s = await requireAdmin();
  const [p, interval] = await Promise.all([
    db.participant.findFirst({ where: { id: pid, programId: s.programId }, include: { role: true } }),
    db.interval.findFirst({ where: { id: iv, programId: s.programId } }),
  ]);
  if (!p || !interval) redirect("/assignments?error=" + encodeURIComponent("That participant or interval does not exist."));
  const a = await db.assignment.findFirst({ where: { participantId: pid, startDate: { lte: interval.endDate }, endDate: { gte: interval.startDate } }, orderBy: { startDate: "asc" } });
  return { s, p, interval, a };
}
const inside = (d: Date | null, iv: { startDate: Date; endDate: Date }) => !d || (d >= iv.startDate && d <= iv.endDate);
const done = (pid: string, iv: string, text: string, anchor = "") => { revalidatePath("/", "layout"); back(pid, iv, "notice", text, anchor); };

/** Put a participant on an interval: the whole interval, shift counts from their role, every institution until chosen otherwise. */
export async function assignToInterval(pid: string, iv: string) {
  const { s, p, interval, a } = await scope(pid, iv);
  if (a) back(pid, iv, "error", "Already assigned to this interval.");
  const others = await db.assignment.findMany({ where: { participantId: pid } });
  if (others.some((o) => overlaps(o.startDate, o.endDate, interval.startDate, interval.endDate)))
    back(pid, iv, "error", "This person has an older assignment that overlaps the interval. Remove it first.");
  const insts = await db.institution.findMany({ where: { programId: s.programId, active: true, archivedAt: null } });
  await db.assignment.create({ data: {
    programId: s.programId, participantId: pid, intervalId: iv, startDate: interval.startDate, endDate: interval.endDate,
    institutions: { create: insts.map((i) => ({ institutionId: i.id })) },
  } });
  done(pid, iv, `${p.firstName} ${p.lastName} is assigned to ${interval.name}.`);
}

export async function removeFromInterval(pid: string, iv: string) {
  const { a, p, interval } = await scope(pid, iv);
  if (!a) back(pid, iv, "error", "Not assigned to this interval.");
  await db.$transaction([
    db.timeOff.updateMany({ where: { assignmentId: a!.id }, data: { assignmentId: null } }),
    db.assignment.delete({ where: { id: a!.id } }),
  ]);
  done(pid, iv, `${p.firstName} ${p.lastName} is no longer assigned to ${interval.name}. Their time off, adjustments and notes for it are kept.`);
}

/** Institutions, with a target split when there are two or more, and optional dates at each. */
export async function saveInstitutions(pid: string, iv: string, fd: FormData) {
  const { s, a, interval } = await scope(pid, iv);
  if (!a) back(pid, iv, "error", "Assign this person to the interval first.");
  const insts = await db.institution.findMany({ where: { programId: s.programId } });
  const chosen = insts.filter((i) => fd.get(`inst_${i.id}`) === "on");
  if (!chosen.length) back(pid, iv, "error", "Choose at least one institution.", "institutions");
  const rows = [];
  for (const i of chosen) {
    const pct = str(fd, `pct_${i.id}`), from = str(fd, `from_${i.id}`), until = str(fd, `until_${i.id}`);
    const sharePercent = chosen.length > 1 ? (/^\d{1,3}$/.test(pct) ? Number(pct) : NaN) : null;
    if (chosen.length > 1 && !(sharePercent! >= 0 && sharePercent! <= 100)) back(pid, iv, "error", `Enter the percentage of shifts at ${i.name} (0 to 100).`, "institutions");
    const startDate = from ? date(from) : null, endDate = until ? date(until) : null;
    if ((from && !startDate) || (until && !endDate)) back(pid, iv, "error", `The dates at ${i.name} are not valid dates.`, "institutions");
    if (!inside(startDate, interval) || !inside(endDate, interval)) back(pid, iv, "error", `The dates at ${i.name} must be inside ${interval.name}.`, "institutions");
    if (startDate && endDate && endDate < startDate) back(pid, iv, "error", `At ${i.name}, "until" is before "from".`, "institutions");
    rows.push({ institutionId: i.id, sharePercent, startDate: startDate && startDate > interval.startDate ? startDate : null, endDate: endDate && endDate < interval.endDate ? endDate : null });
  }
  if (rows.length > 1) {
    const sum = rows.reduce((t, r) => t + (r.sharePercent ?? 0), 0);
    if (sum !== 100) back(pid, iv, "error", `The percentages add up to ${sum}%. They must add up to 100%.`, "institutions");
  }
  await db.$transaction([
    db.assignmentInstitution.deleteMany({ where: { assignmentId: a!.id } }),
    db.assignmentInstitution.createMany({ data: rows.map((r) => ({ assignmentId: a!.id, ...r })) }),
  ]);
  done(pid, iv, "Institutions saved.", "institutions");
}

export async function addAdjustment(pid: string, iv: string, fd: FormData) {
  const { s } = await scope(pid, iv);
  const delta = Number(str(fd, "delta"));
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 31) back(pid, iv, "error", "Enter a whole number of shifts to add (e.g. 2) or take away (e.g. -2).", "adjustments");
  await db.shiftAdjustment.create({ data: { programId: s.programId, participantId: pid, intervalId: iv, delta, reason: str(fd, "reason").slice(0, 500), createdById: s.userId } });
  done(pid, iv, `Adjustment of ${delta > 0 ? "+" : ""}${delta} shift${Math.abs(delta) === 1 ? "" : "s"} added.`, "adjustments");
}

export async function deleteAdjustment(pid: string, iv: string, id: string) {
  await scope(pid, iv);
  await db.shiftAdjustment.deleteMany({ where: { id, participantId: pid, intervalId: iv } });
  done(pid, iv, "Adjustment removed.", "adjustments");
}

/** Required time off: whole days, or the same time window on each of those days. Always enforced. */
export async function addRequiredOff(pid: string, iv: string, fd: FormData) {
  const { s, a, interval } = await scope(pid, iv);
  const from = date(str(fd, "from")), until = date(str(fd, "until") || str(fd, "from"));
  if (!from || !until) back(pid, iv, "error", "Enter the date (or dates) off.", "time-off");
  if (until! < from!) back(pid, iv, "error", "The last day is before the first.", "time-off");
  if (!overlaps(from!, until!, interval.startDate, interval.endDate)) back(pid, iv, "error", `The dates must fall inside ${interval.name}.`, "time-off");
  const wholeDay = fd.get("wholeDay") === "on";
  const startMinute = wholeDay ? null : minutes(str(fd, "startTime")), endMinute = wholeDay ? null : minutes(str(fd, "endTime"));
  if (!wholeDay && (startMinute == null || endMinute == null || startMinute === endMinute)) back(pid, iv, "error", "Enter a start and end time, or tick \"whole day\".", "time-off");
  await db.timeOff.create({ data: {
    programId: s.programId, participantId: pid, intervalId: iv, assignmentId: a?.id ?? null, kind: "REQUIRED_OFF", startDate: from!, endDate: until!,
    startMinute, endMinute, mandatory: true, status: "APPROVED", reason: str(fd, "reason").slice(0, 500) || null, createdById: s.userId,
  } });
  done(pid, iv, "Required time off added. The schedule will never put them on a shift then.", "time-off");
}

export async function deleteTimeOff(pid: string, iv: string, id: string) {
  await scope(pid, iv);
  await db.timeOff.deleteMany({ where: { id, participantId: pid, kind: "REQUIRED_OFF" } });
  done(pid, iv, "Required time off removed.", "time-off");
}

/** "No nights" and the administrator's notes, both on the assignment. */
export async function savePreferences(pid: string, iv: string, fd: FormData) {
  const { a } = await scope(pid, iv);
  if (!a) back(pid, iv, "error", "Assign this person to the interval first.");
  await db.assignment.update({ where: { id: a!.id }, data: { noNights: fd.get("noNights") === "on", notes: str(fd, "notes").slice(0, 4000) || null } });
  done(pid, iv, "Saved.", "preferences");
}

/** A personal academic day: like the program's academic days, but only for this person. */
export async function addPersonalAcademic(pid: string, iv: string, fd: FormData) {
  const { s, interval } = await scope(pid, iv);
  const name = str(fd, "name"), weekday = Number(str(fd, "dayOfWeek")), start = minutes(str(fd, "startTime"));
  const hours = Number(str(fd, "hours"));
  if (!name) back(pid, iv, "error", "Give the academic day a name.", "academic");
  if (!(weekday >= 0 && weekday <= 6) || start == null) back(pid, iv, "error", "Choose the weekday and start time.", "academic");
  if (!(hours > 0 && hours <= 24)) back(pid, iv, "error", "Enter how long it lasts, in hours (up to 24).", "academic");
  const from = date(str(fd, "from")) ?? interval.startDate, until = date(str(fd, "until")) ?? interval.endDate;
  if (until < from) back(pid, iv, "error", "The last date is before the first.", "academic");
  const skip = str(fd, "skip").split(/[\s,;]+/).filter(Boolean);
  const skipDates = skip.map(date);
  if (skipDates.some((d) => !d)) back(pid, iv, "error", "Dates it does not happen must be written as YYYY-MM-DD, separated by commas.", "academic");
  await db.academicDay.create({ data: {
    programId: s.programId, participantId: pid, name: name.slice(0, 120), dayOfWeek: weekday, startMinute: start!, durationMinutes: Math.round(hours * 60),
    startDate: from, endDate: until, overlapPolicy: fd.get("blocks") === "on" ? "BLOCKED" : "EXCUSED",
    occurrences: { create: [...new Set(skip)].map((d) => ({ date: parseYmd(d), cancelled: true })) },
  } });
  done(pid, iv, "Personal academic day added.", "academic");
}

export async function deletePersonalAcademic(pid: string, iv: string, id: string) {
  const { s } = await scope(pid, iv);
  await db.academicDay.deleteMany({ where: { id, participantId: pid, programId: s.programId } });
  done(pid, iv, "Personal academic day removed.", "academic");
}
