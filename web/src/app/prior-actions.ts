"use server";
// How the previous interval ended, typed in when no schedule for it is published here.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { addDays, parseYmd, toMinutes, ymd } from "@/lib/util";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const back = (iv: string, kind: "notice" | "error", text: string): never =>
  redirect(`/intervals/${iv}?tab=schedule&${kind}=${encodeURIComponent(text)}#prior`);

async function scope(intervalId: string) {
  const s = await requireAdmin();
  const iv = await db.interval.findFirst({ where: { id: intervalId, programId: s.programId } });
  if (!iv) redirect("/intervals");
  return { s, iv };
}
const window7 = (start: Date) => ({ from: addDays(start, -7), to: addDays(start, -1) });

type Row = { participantId: string; date: Date; name: string; startMinute: number; durationMinutes: number; categoryId: string; shiftId: string | null };

export async function addPriorShift(intervalId: string, fd: FormData) {
  const { s, iv } = await scope(intervalId);
  const w = window7(iv.startDate);
  const p = await db.participant.findFirst({ where: { id: str(fd, "participantId"), programId: s.programId } });
  if (!p) back(intervalId, "error", "Choose who worked the shift.");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(fd, "date")) ? parseYmd(str(fd, "date")) : null;
  if (!date || date < w.from || date > w.to) back(intervalId, "error", `The date must be in the 7 days before ${iv.name} starts (${ymd(w.from)} to ${ymd(w.to)}).`);
  const shift = str(fd, "shiftId") ? await db.shift.findFirst({ where: { id: str(fd, "shiftId"), programId: s.programId } }) : null;
  let row: Row;
  if (shift) row = { participantId: p!.id, date: date!, name: shift.name, startMinute: shift.startMinute, durationMinutes: shift.durationMinutes, categoryId: shift.categoryId, shiftId: shift.id };
  else {
    const st = /^\d{1,2}:\d{2}$/.test(str(fd, "start")) ? toMinutes(str(fd, "start")) : NaN, h = Number(str(fd, "hours"));
    const cat = await db.shiftCategory.findFirst({ where: { id: str(fd, "categoryId"), programId: s.programId } });
    if (!(st >= 0 && st < 1440) || !(h > 0 && h <= 48) || !cat) back(intervalId, "error", "Pick a shift, or enter a start time, hours and category.");
    row = { participantId: p!.id, date: date!, name: str(fd, "name") || `${cat!.name} shift`, startMinute: st, durationMinutes: Math.round(h * 60), categoryId: cat!.id, shiftId: null };
  }
  await db.priorShift.create({ data: { intervalId, ...row } });
  revalidatePath("/", "layout");
  back(intervalId, "notice", "Added.");
}

/** Pasted lines: "Last name or full name, YYYY-MM-DD, shift name" (comma or tab separated), one per line. */
export async function pastePriorShifts(intervalId: string, fd: FormData) {
  const { s, iv } = await scope(intervalId);
  const w = window7(iv.startDate);
  const [people, shifts] = await Promise.all([
    db.participant.findMany({ where: { programId: s.programId, archivedAt: null } }),
    db.shift.findMany({ where: { programId: s.programId, archivedAt: null, isBackup: false } }),
  ]);
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const rows: Row[] = [], bad: string[] = [];
  for (const [i, raw] of str(fd, "pasted").split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const [who = "", when = "", what = ""] = raw.split(/\t|,/).map((x) => x.trim());
    const matches = people.filter((p) => [norm(`${p.firstName} ${p.lastName}`), norm(`${p.lastName}, ${p.firstName}`), norm(p.lastName)].includes(norm(who)));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(when) ? parseYmd(when) : null;
    const shift = shifts.find((x) => norm(x.name) === norm(what));
    const why = matches.length !== 1 ? (matches.length ? `"${who}" matches more than one person` : `nobody called "${who}"`)
      : !date ? `"${when}" is not a date (use YYYY-MM-DD)` : date < w.from || date > w.to ? `${when} is not in the 7 days before the interval`
      : !shift ? `no shift called "${what}"` : null;
    if (why) { bad.push(`line ${i + 1}: ${why}`); continue; }
    rows.push({ participantId: matches[0].id, date: date!, name: shift!.name, startMinute: shift!.startMinute, durationMinutes: shift!.durationMinutes, categoryId: shift!.categoryId, shiftId: shift!.id });
  }
  if (bad.length) back(intervalId, "error", `Nothing was added. Fix these and paste again: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? "; …" : ""}`);
  if (!rows.length) back(intervalId, "error", "Paste at least one line.");
  await db.priorShift.createMany({ data: rows.map((r) => ({ intervalId, ...r })) });
  revalidatePath("/", "layout");
  back(intervalId, "notice", `${rows.length} shift${rows.length === 1 ? "" : "s"} added.`);
}

export async function deletePriorShift(intervalId: string, id: string) {
  await scope(intervalId);
  await db.priorShift.deleteMany({ where: { id, intervalId } });
  revalidatePath("/", "layout");
  back(intervalId, "notice", "Removed.");
}

export async function clearPriorShifts(intervalId: string) {
  await scope(intervalId);
  await db.priorShift.deleteMany({ where: { intervalId } });
  revalidatePath("/", "layout");
  back(intervalId, "notice", "All entered shifts removed.");
}
