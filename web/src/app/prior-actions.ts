"use server";
// How the previous interval ended, typed in when no schedule for it is published here.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { addDays, fmtShort, parseYmd, toMinutes, ymd } from "@/lib/util";
import { importPrior } from "@/lib/prior-import";

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

const MAX_UPLOAD = 5 * 1024 * 1024;
const list = (xs: string[], n = 5) => xs.slice(0, n).join("; ") + (xs.length > n ? `; and ${xs.length - n} more` : "");

/** An uploaded .xlsx/.csv of the previous schedule: the shifts in the 7 days before the interval are added. */
export async function uploadPriorShifts(intervalId: string, fd: FormData) {
  const { s, iv } = await scope(intervalId);
  const w = window7(iv.startDate);
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) back(intervalId, "error", "Choose a file to upload.");
  const f = file as File;
  if (/\.xls$/i.test(f.name)) back(intervalId, "error", "That is an old-style .xls file. Open it in Excel and use Save As → Excel Workbook (.xlsx), then upload that.");
  if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) back(intervalId, "error", "Upload an Excel workbook (.xlsx) or a .csv file.");
  if (f.size > MAX_UPLOAD) back(intervalId, "error", "That file is over 5 MB. Upload just the schedule (one block), or delete other sheets first.");
  const [people, shifts] = await Promise.all([
    db.participant.findMany({ where: { programId: s.programId, archivedAt: null }, select: { id: true, firstName: true, lastName: true, email: true } }),
    db.shift.findMany({ where: { programId: s.programId, archivedAt: null, isBackup: false }, include: { institution: true } }),
  ]);
  let res;
  try {
    res = await importPrior(Buffer.from(await f.arrayBuffer()), f.name, people, shifts, w, iv.startDate);
  } catch {
    back(intervalId, "error", "That file could not be read as a spreadsheet. Open it in Excel, save it as .xlsx, and try again.");
  }
  const range = `${fmtShort(w.from)}–${fmtShort(w.to)}`;
  if (!res || !res.found.length) {
    const covers = res?.fileDates ? ` The file has shifts from ${fmtShort(res.fileDates[0])} to ${fmtShort(res.fileDates[1])}.` : "";
    const why = res?.problems.length ? ` Could not read: ${list(res.problems)}.` : "";
    back(intervalId, "error", `No shifts dated ${range} (the 7 days before ${iv.name}) were found in ${f.name}.${covers}${why}`);
  }
  const r = res!;
  const byId = new Map(shifts.map((x) => [x.id, x]));
  const key = (pid: string, d: Date, sid: string) => `${pid}|${ymd(d)}|${sid}`;
  const replace = fd.get("replace") === "on";
  const existing = replace ? new Set<string>() : new Set((await db.priorShift.findMany({ where: { intervalId } })).map((x) => key(x.participantId, x.date, x.shiftId ?? x.name)));
  const rows: Row[] = [], keys = new Set<string>();
  let dup = 0;
  for (const x of r.found) {
    const k = key(x.participantId, x.date, x.shiftId);
    if (keys.has(k)) continue;
    keys.add(k);
    if (existing.has(k)) { dup++; continue; }
    const sh = byId.get(x.shiftId)!;
    rows.push({ participantId: x.participantId, date: x.date, name: sh.name, startMinute: sh.startMinute, durationMinutes: sh.durationMinutes, categoryId: sh.categoryId, shiftId: sh.id });
  }
  await db.$transaction([
    ...(replace ? [db.priorShift.deleteMany({ where: { intervalId } })] : []),
    db.priorShift.createMany({ data: rows.map((x) => ({ intervalId, ...x })) }),
  ]);
  revalidatePath("/", "layout");
  const who = new Set(rows.map((x) => x.participantId)).size;
  const parts = [
    `Read "${r.sheet}" (${r.layout}): added ${rows.length} shift${rows.length === 1 ? "" : "s"} for ${who} ${who === 1 ? "person" : "people"}, ${range}${replace ? ", replacing what was entered before" : ""}.`,
    dup ? `${dup} already entered ${dup === 1 ? "was" : "were"} skipped.` : "",
    r.outside ? `Shifts on other dates in the file were left out.` : "",
    r.problems.length ? `Not added, check these by hand: ${list(r.problems)}.` : "",
  ];
  back(intervalId, "notice", parts.filter(Boolean).join(" "));
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
