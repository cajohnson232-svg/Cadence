"use server";
// Special staffing days: save a day with its changes in one go, and read plain-English changes into proposed lines.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { proposeSpecialDay, type DayLine, type DayProposal } from "@/lib/assist";
import { dow, parseYmd } from "@/lib/util";

export type DayPayload = {
  institutionId: string; date: string; name: string; mode: "MODIFY" | "REPLACE"; changeText: string;
  lines: DayLine[]; // MODIFY: the changes. REPLACE: one ADD line per shift that runs (copied, optionally with new times / people)
};

export async function readDayChanges(input: { institutionId: string; date: string; text: string }): Promise<DayProposal | { error: string }> {
  const s = await requireAdmin();
  if (input.text.trim().length < 4) return { error: "Describe the changes first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: "Choose the date first." };
  const inst = await db.institution.findFirst({ where: { id: input.institutionId, programId: s.programId } });
  if (!inst) return { error: "Choose the institution first." };
  const [shifts, cats] = await Promise.all([
    db.shift.findMany({ where: { institutionId: inst.id, archivedAt: null, isBackup: false }, orderBy: { startMinute: "asc" } }),
    db.shiftCategory.findMany({ where: { programId: s.programId } }),
  ]);
  const wd = dow(parseYmd(input.date));
  return proposeSpecialDay(input.text.slice(0, 2000), {
    today: new Date().toISOString().slice(0, 10), date: input.date, institution: inst.name,
    categories: cats.map((c) => ({ id: c.id, name: c.name, isNight: c.isNight })),
    shifts: shifts.map((x) => ({ id: x.id, name: x.name, startMinute: x.startMinute, durationMinutes: x.durationMinutes, minParticipants: x.minParticipants, categoryId: x.categoryId,
      runsThatDay: x.active && x.daysOfWeek.includes(wd), active: x.active })),
  });
}

export async function saveSpecialDay(id: string | null, p: DayPayload): Promise<{ error: string } | void> {
  const s = await requireAdmin();
  const inst = await db.institution.findFirst({ where: { id: p.institutionId, programId: s.programId } });
  if (!inst) return { error: "Choose the institution." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return { error: "Choose the date." };
  if (!p.name.trim()) return { error: "Give the day a name, e.g. Thanksgiving." };
  if (p.mode !== "MODIFY" && p.mode !== "REPLACE") return { error: "Choose Modify or Replace." };
  const date = parseYmd(p.date);
  if (id && !(await db.specialStaffingDay.findFirst({ where: { id, programId: s.programId } }))) return { error: "That special staffing day no longer exists." };
  const clash = await db.specialStaffingDay.findFirst({ where: { institutionId: inst.id, date, ...(id ? { id: { not: id } } : {}) } });
  if (clash) return { error: `${clash.name} is already set up for ${inst.name} on that date.` };
  const shifts = new Map((await db.shift.findMany({ where: { institutionId: inst.id, isBackup: false } })).map((x) => [x.id, x]));
  const cats = new Set((await db.shiftCategory.findMany({ where: { programId: s.programId } })).map((c) => c.id));
  const lines = (p.lines ?? []).slice(0, 60);
  if (p.mode === "REPLACE" && !lines.length) return { error: "Tick at least one shift to run that day." };
  if (p.mode === "MODIFY" && !lines.length) return { error: "There are no changes yet. Describe them and press \"Read the changes\", or add a line." };
  for (const [i, l] of lines.entries()) {
    const n = `Line ${i + 1}`;
    if (!["ADD", "CHANGE", "REMOVE"].includes(l.action)) return { error: `${n}: unknown change.` };
    if (p.mode === "REPLACE" && l.action !== "ADD") return { error: "A replaced day only lists the shifts that run." };
    if (l.shiftId && !shifts.has(l.shiftId)) return { error: `${n}: that shift is not at ${inst.name}.` };
    if (!l.shiftId) return { error: l.action === "ADD" ? `${n}: choose the normal shift this extra one is like. Its role grid decides who can work it; the name, times and people can still be changed.` : `${n}: choose which normal shift changes.` };
    if (l.categoryId && !cats.has(l.categoryId)) return { error: `${n}: unknown category.` };
    if (l.startMinute != null && !(l.startMinute >= 0 && l.startMinute < 1440)) return { error: `${n}: start time is not valid.` };
    if (l.durationMinutes != null && !(l.durationMinutes > 0 && l.durationMinutes <= 2880)) return { error: `${n}: length is not valid.` };
    if (l.minParticipants != null && !(l.minParticipants >= 0 && l.minParticipants <= 50)) return { error: `${n}: number of people is not valid.` };
  }
  const data = { institutionId: inst.id, date, name: p.name.trim().slice(0, 120), mode: p.mode, changeText: p.mode === "MODIFY" ? p.changeText.trim().slice(0, 4000) || null : null };
  const rows = lines.map((l) => ({ action: l.action, shiftId: l.shiftId,
    ...(l.action === "REMOVE" ? {} : { name: l.action === "ADD" ? l.name?.trim() || null : null, categoryId: l.categoryId, startMinute: l.startMinute, durationMinutes: l.durationMinutes,
      minParticipants: l.minParticipants, maxParticipants: l.minParticipants }) }));
  const day = await db.$transaction(async (tx) => {
    const d = id ? await tx.specialStaffingDay.update({ where: { id }, data }) : await tx.specialStaffingDay.create({ data: { ...data, programId: s.programId } });
    await tx.specialStaffingShift.deleteMany({ where: { specialStaffingDayId: d.id } });
    await tx.specialStaffingShift.createMany({ data: rows.map((r) => ({ ...r, specialStaffingDayId: d.id })) });
    return d;
  });
  revalidatePath("/", "layout");
  redirect(`/special-days/${day.id}?notice=${encodeURIComponent("Special staffing day saved.")}`);
}

export async function deleteSpecialDay(id: string) {
  const s = await requireAdmin();
  const day = await db.specialStaffingDay.findFirst({ where: { id, programId: s.programId } });
  if (day) {
    try { await db.specialStaffingDay.delete({ where: { id } }); }
    catch { redirect(`/special-days/${id}?error=${encodeURIComponent("This day is used by a saved schedule, so it cannot be deleted. Change its lines instead.")}`); }
  }
  revalidatePath("/", "layout");
  redirect(`/special-days?notice=${encodeURIComponent("Special staffing day deleted.")}`);
}
