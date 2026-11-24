// A schedule as an Excel workbook with the same four views as the review page:
// "By person", "By shift", "Calendar" and "Goals & checks".
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { publishChecks } from "@/lib/schedules";
import { GOALS, categoryColors, shortCodes } from "@/lib/schedule-view";
import { DOW, addDays, dayDiff, dow, fmtDate, fmtRange, fmtShort, hhmm, ymd } from "@/lib/util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const minute = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const span = (a: Date, b: Date) => `${hhmm(minute(a))}–${hhmm(minute(b))}`;
const g = (n: number) => +n.toFixed(1);

/** ARGB fill colour: `hex` mixed with white, `pct` percent of the colour (like the page's tint()). */
export function tintArgb(hex: string, pct: number): string {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return "FF" + c.map((v) => Math.round(255 + (v - 255) * (pct / 100)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin: Partial<ExcelJS.Borders> = Object.fromEntries((["top", "left", "bottom", "right"] as const).map((k) => [k, { style: "thin", color: { argb: "FFD4D8DE" } }]));
const GREY = "FFF1F5F9", WEEKEND = "FFF8FAFC", ACADEMIC = "FFE0F2FE", BACKUP = "FFEDE9FE", OPEN = "FFFEE2E2", RED = "FFB91C1C", MUTED = "FF64748B";

export async function scheduleWorkbook(sid: string, programId: string): Promise<{ buffer: Buffer; filename: string } | null> {
  const checks = await publishChecks(sid, programId);
  if (!checks || checks.sch.runStatus !== "DONE") return null;
  const { sch } = checks, iv = sch.interval;
  const [rows, backupRows, cats, everyone, insts] = await Promise.all([
    db.scheduledShift.findMany({ where: { scheduleId: sid, backup: false }, include: { institution: true }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] }),
    db.scheduledShift.findMany({ where: { scheduleId: sid, backup: true }, include: { institution: true }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] }),
    db.shiftCategory.findMany({ where: { programId } }),
    db.participant.findMany({ where: { programId }, include: { role: true } }),
    db.institution.findMany({ where: { programId }, orderBy: { shortCode: "asc" } }),
  ]);
  const rep = sch.report as Any, snap = sch.inputSnapshot as Any;

  const n = dayDiff(iv.startDate, iv.endDate) + 1;
  const days = Array.from({ length: n }, (_, i) => addDays(iv.startDate, i));
  const dayOf = (d: Date) => dayDiff(iv.startDate, d);
  const calOf = (d: Date) => dayDiff(iv.startDate, new Date(ymd(d) + "T00:00:00Z"));
  const inRange = rows.filter((r) => dayOf(r.dutyDate) >= 0 && dayOf(r.dutyDate) < n);
  const color = categoryColors(cats), catById = new Map(cats.map((c) => [c.id, c]));
  const shade = (catId: string, strong = false) => tintArgb(color.get(catId) ?? "#64748b", (catById.get(catId)?.isNight ? 32 : 20) - (strong ? 0 : 8));
  const code = shortCodes(rows.map((r) => r.name));
  const instCode = new Map(insts.map((i) => [i.id, i.shortCode]));
  const byId = new Map(everyone.map((p) => [p.id, p]));
  const lastNames = new Map<string, number>();
  for (const p of everyone) lastNames.set(p.lastName, (lastNames.get(p.lastName) ?? 0) + 1);
  const short = (pid: string) => { const p = byId.get(pid); return !p ? "?" : (lastNames.get(p.lastName) ?? 0) > 1 ? `${p.lastName} ${p.firstName[0]}.` : p.lastName; };
  const initialLast = (pid: string) => { const p = byId.get(pid); return p ? `${p.firstName.slice(0, 1)}. ${p.lastName}` : "?"; };
  const full = (pid: string) => { const p = byId.get(pid); return p ? `${p.lastName}, ${p.firstName}` : "?"; };
  const snapPeople = new Map<string, Any>((snap?.residents ?? []).map((r: Any) => [r.id, r]));
  const stats = new Map<string, Any>((rep?.residents ?? []).map((r: Any) => [r.id, r]));
  const ids = [...new Set<string>([...snapPeople.keys(), ...rows.flatMap((r) => (r.participantId ? [r.participantId] : []))])]
    .filter((p) => byId.has(p))
    .sort((a, b) => byId.get(a)!.role.level - byId.get(b)!.role.level || byId.get(a)!.lastName.localeCompare(byId.get(b)!.lastName) || byId.get(a)!.firstName.localeCompare(byId.get(b)!.firstName));
  const academic = new Map<number, string[]>();          // program academic time only (not personal academic days)
  for (const a of (snap?.academic_time ?? []) as Any[]) if (a.day >= 0 && a.day < n && !(a.pgy?.length === 1 && a.pgy[0] === -1)) academic.set(a.day, [...(academic.get(a.day) ?? []), `${a.name} ${a.start} (${a.hours}h)`]);
  const title = `${iv.name} · ${sch.label ?? "Schedule"} · ${fmtRange(iv.startDate, iv.endDate)}${sch.status === "PUBLISHED" ? " · Published" : " · Draft"}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Cadence";
  wb.created = new Date();

  const heading = (ws: ExcelJS.Worksheet, text: string, sub?: string) => {
    ws.getCell("A1").value = text;
    ws.getCell("A1").font = { bold: true, size: 14 };
    if (sub) { ws.getCell("A2").value = sub; ws.getCell("A2").font = { color: { argb: MUTED }, size: 10 }; }
  };
  const dayHead = (c: ExcelJS.Cell, i: number, d: Date) => {
    c.value = `${DOW[dow(d)]}\n${d.getUTCDate()}`;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.font = { bold: true, size: 9 };
    c.border = thin;
    if (academic.has(i)) { c.fill = fill(ACADEMIC); c.note = academic.get(i)!.join("\n"); }
    else if (dow(d) >= 5) c.fill = fill(GREY);
  };

  // ───────── By person ─────────
  {
    const ws = wb.addWorksheet("By person", { views: [{ state: "frozen", xSplit: 5, ySplit: 4 }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    heading(ws, title, "One row per person. Codes are explained under the grid. A night that starts after midnight is shown on the day it belongs to (the evening before).");
    const fixed = ["Participant", "Role", "Shifts", "Nights", "Backup"];
    const hr = ws.getRow(4);
    fixed.forEach((h, j) => { const c = hr.getCell(j + 1); c.value = h; c.font = { bold: true, size: 9 }; c.border = thin; c.alignment = { vertical: "middle", horizontal: j ? "center" : "left" }; });
    days.forEach((d, i) => dayHead(hr.getCell(6 + i), i, d));
    hr.height = 28;
    ws.getColumn(1).width = 24; ws.getColumn(2).width = 11; ws.getColumn(3).width = 8; ws.getColumn(4).width = 7; ws.getColumn(5).width = 7;
    for (let i = 0; i < n; i++) ws.getColumn(6 + i).width = 6;

    const mine = new Map<string, Map<number, typeof rows>>();
    for (const r of inRange) if (r.participantId) {
      const m = mine.get(r.participantId) ?? new Map(); mine.set(r.participantId, m);
      m.set(dayOf(r.dutyDate), [...(m.get(dayOf(r.dutyDate)) ?? []), r]);
    }
    const backupBy = new Map<string, Map<number, (typeof backupRows)[number]>>();
    for (const b of backupRows) if (b.participantId) { const m = backupBy.get(b.participantId) ?? new Map(); backupBy.set(b.participantId, m); m.set(dayOf(b.dutyDate), b); }

    let rn = 5, role = "";
    for (const pid of ids) {
      const p = byId.get(pid)!, sn = snapPeople.get(pid);
      if (p.role.name !== role) {
        role = p.role.name;
        const rr = ws.getRow(rn++);
        rr.getCell(1).value = role; rr.getCell(1).font = { bold: true, color: { argb: MUTED }, size: 9 };
        for (let j = 1; j <= 5 + n; j++) rr.getCell(j).fill = fill(GREY);
      }
      const shifts = [...(mine.get(pid)?.values() ?? [])].flat();
      const count = shifts.length, nights = shifts.filter((r) => catById.get(r.categoryId)?.isNight).length;
      const row = ws.getRow(rn++);
      row.getCell(1).value = `${p.lastName}, ${p.firstName}`;
      row.getCell(2).value = p.role.name;
      const cc = row.getCell(3);
      cc.value = sn ? `${count} / ${sn.shifts_min === sn.shifts_max ? sn.shifts_max : `${sn.shifts_min}–${sn.shifts_max}`}` : count;
      if (sn && (count < sn.shifts_min || count > sn.shifts_max)) { cc.font = { bold: true, color: { argb: RED } }; cc.fill = fill(OPEN); }
      row.getCell(4).value = nights || null;
      row.getCell(5).value = backupBy.get(pid)?.size || null;
      for (let j = 1; j <= 5; j++) { row.getCell(j).border = thin; if (j > 2) row.getCell(j).alignment = { horizontal: "center" }; }
      for (let i = 0; i < n; i++) {
        const c = row.getCell(6 + i), d = days[i];
        c.border = thin; c.alignment = { horizontal: "center", vertical: "middle" }; c.font = { size: 9 };
        const x = mine.get(pid)?.get(i) ?? [];
        if (x.length) {
          const r = x[0], wanted = sn?.requests_off && String(calOf(r.startsAt)) in sn.requests_off;
          c.value = (code.get(r.name) ?? r.name) + (x.length > 1 ? "+" : "");
          c.font = { size: 9, bold: true };
          c.fill = fill(shade(r.categoryId, true));
          c.note = `${r.name} · ${r.institution.name}\n${fmtDate(new Date(ymd(r.startsAt) + "T00:00:00Z"))} ${span(r.startsAt, r.endsAt)}` + (wanted ? "\nAsked for this day off (request not granted)" : "");
          if (wanted) c.border = Object.fromEntries((["top", "left", "bottom", "right"] as const).map((k) => [k, { style: "medium", color: { argb: "FFEF4444" } }]));
          continue;
        }
        const bu = backupBy.get(pid)?.get(i);
        if (bu) { c.value = "BU"; c.font = { size: 9, bold: true, color: { argb: "FF5B21B6" } }; c.fill = fill(BACKUP); c.note = `${bu.name} (on call) ${span(bu.startsAt, bu.endsAt)}`; }
        else if (sn?.vacation?.includes(i)) { c.value = "VAC"; c.fill = fill("FFE2E8F0"); c.font = { size: 9, color: { argb: "FF475569" } }; }
        else if (sn?.mandatory_off?.includes(i)) { c.value = "off"; c.fill = fill(GREY); c.font = { size: 9, color: { argb: "FF94A3B8" } }; }
        else if (sn?.requests_off && String(i) in sn.requests_off) { c.value = "req"; c.font = { size: 9, color: { argb: "FF047857" } }; }
        else if (dow(d) >= 5) c.fill = fill(WEEKEND);
      }
    }
    // legend
    rn += 1;
    ws.getRow(rn++).getCell(1).value = "Codes";
    ws.getRow(rn - 1).getCell(1).font = { bold: true };
    for (const [name, c] of [...code.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const r = rows.find((x) => x.name === name)!;
      const row = ws.getRow(rn++);
      row.getCell(1).value = c; row.getCell(1).font = { bold: true }; row.getCell(1).fill = fill(shade(r.categoryId, true));
      row.getCell(2).value = `${name} · ${r.institution.shortCode} · ${span(r.startsAt, r.endsAt)}`;
    }
    const extra: [string, string][] = [["BU", "On backup (on call; not a worked shift)"], ["VAC", "Vacation"], ["off", "Not available that day (not assigned, or a required day off)"], ["req", "A request off that was granted"], ["red outline", "Working on a day they asked to have off"], ["blue date", "Academic time that day"]];
    for (const [k, v] of extra) { const row = ws.getRow(rn++); row.getCell(1).value = k; row.getCell(2).value = v; }
  }

  // ───────── By shift ─────────
  {
    const ws = wb.addWorksheet("By shift", { views: [{ state: "frozen", xSplit: 3, ySplit: 4 }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    heading(ws, title, "One row per shift, grouped by institution, with who is working it each day. OPEN = nobody on it yet.");
    const hr = ws.getRow(4);
    ["Shift", "Time", "Type"].forEach((h, j) => { const c = hr.getCell(j + 1); c.value = h; c.font = { bold: true, size: 9 }; c.border = thin; c.alignment = { vertical: "middle" }; });
    days.forEach((d, i) => dayHead(hr.getCell(4 + i), i, d));
    hr.height = 28;
    ws.getColumn(1).width = 26; ws.getColumn(2).width = 12; ws.getColumn(3).width = 9;
    for (let i = 0; i < n; i++) ws.getColumn(4 + i).width = 11;

    const lines = new Map<string, { name: string; inst: string; start: number; dur: number; cat: string; cells: Map<number, typeof rows> }>();
    for (const r of inRange) {
      const start = minute(r.startsAt), dur = Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60000);
      const key = `${r.institution.name}|${String(start).padStart(4, "0")}|${r.name}|${dur}`;
      const line = lines.get(key) ?? { name: r.name, inst: r.institution.name, start, dur, cat: r.categoryId, cells: new Map() };
      lines.set(key, line);
      line.cells.set(dayOf(r.dutyDate), [...(line.cells.get(dayOf(r.dutyDate)) ?? []), r]);
    }
    let rn = 5, inst = "";
    for (const [, l] of [...lines.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (l.inst !== inst) {
        inst = l.inst;
        const rr = ws.getRow(rn++);
        rr.getCell(1).value = inst; rr.getCell(1).font = { bold: true, color: { argb: MUTED }, size: 9 };
        for (let j = 1; j <= 3 + n; j++) rr.getCell(j).fill = fill(GREY);
      }
      const row = ws.getRow(rn++);
      row.getCell(1).value = l.name; row.getCell(1).font = { bold: true, size: 10 };
      row.getCell(1).border = { ...thin, left: { style: "thick", color: { argb: "FF" + (color.get(l.cat) ?? "#64748b").replace("#", "").toUpperCase() } } };
      row.getCell(2).value = `${hhmm(l.start)}–${hhmm(l.start + l.dur)}`;
      row.getCell(3).value = catById.get(l.cat)?.name ?? "";
      [2, 3].forEach((j) => { row.getCell(j).border = thin; row.getCell(j).font = { size: 9, color: { argb: MUTED } }; });
      let most = 1;
      for (let i = 0; i < n; i++) {
        const c = row.getCell(4 + i), x = l.cells.get(i) ?? [];
        c.border = thin; c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; c.font = { size: 9 };
        if (!x.length) { c.value = "·"; c.font = { size: 9, color: { argb: "FFCBD5E1" } }; if (dow(days[i]) >= 5) c.fill = fill(WEEKEND); continue; }
        most = Math.max(most, x.length);
        c.value = x.map((r) => (r.participantId ? short(r.participantId) : "OPEN")).join("\n");
        if (x.some((r) => !r.participantId)) { c.fill = fill(OPEN); c.font = { size: 9, bold: true, color: { argb: RED } }; }
        else if (dow(days[i]) >= 5) c.fill = fill(WEEKEND);
      }
      row.height = Math.max(15, most * 12.5);
    }
    if (backupRows.length) {
      rn += 1;
      const rr = ws.getRow(rn++);
      rr.getCell(1).value = "Backup (on call)"; rr.getCell(1).font = { bold: true, color: { argb: MUTED }, size: 9 };
      for (let j = 1; j <= 3 + n; j++) rr.getCell(j).fill = fill(GREY);
      const byName = new Map<string, Map<number, (typeof backupRows)[number][]>>();
      for (const b of backupRows) { const m = byName.get(b.name) ?? new Map(); byName.set(b.name, m); m.set(dayOf(b.dutyDate), [...(m.get(dayOf(b.dutyDate)) ?? []), b]); }
      for (const [name, m] of byName) {
        const row = ws.getRow(rn++), any1 = [...m.values()][0][0];
        row.getCell(1).value = name; row.getCell(1).font = { bold: true, size: 10 };
        row.getCell(2).value = span(any1.startsAt, any1.endsAt); row.getCell(3).value = "Backup";
        for (let j = 1; j <= 3; j++) row.getCell(j).border = thin;
        for (let i = 0; i < n; i++) {
          const c = row.getCell(4 + i), x = m.get(i) ?? [];
          c.border = thin; c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; c.font = { size: 9 };
          if (!x.length) { c.value = "·"; c.font = { size: 9, color: { argb: "FFCBD5E1" } }; continue; }
          c.value = x.map((r) => (r.participantId ? short(r.participantId) : "OPEN")).join("\n");
          c.fill = fill(x.some((r) => !r.participantId) ? OPEN : BACKUP);
        }
      }
    }
  }

  // ───────── Calendar ─────────
  {
    const ws = wb.addWorksheet("Calendar", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const used = insts.filter((i) => [...rows, ...backupRows].some((r) => r.institutionId === i.id));
    const showSite = used.length > 1;
    heading(ws, title, `Every shift each day, in start order, with who is working it${showSite ? ` (${used.map((i) => `${i.shortCode} = ${i.name}`).join(", ")})` : ""}. A night is listed on the day it starts (a night after midnight, on the evening before). OPEN = nobody on it yet.`);
    for (let j = 1; j <= 7; j++) ws.getColumn(j).width = 40;
    const hr = ws.getRow(4);
    DOW.forEach((d, j) => { const c = hr.getCell(j + 1); c.value = d; c.font = { bold: true }; c.border = thin; c.fill = fill(j >= 5 ? "FFE2E8F0" : GREY); });

    type Line = { start: number; inst: string; name: string; backup: boolean; people: string[]; open: number };
    const byDay = new Map<number, Map<string, Line>>();
    for (const r of [...rows, ...backupRows]) {
      const d = dayOf(r.dutyDate), day = byDay.get(d) ?? new Map<string, Line>(); byDay.set(d, day);
      const k = `${r.backup ? 1 : 0}|${minute(r.startsAt)}|${r.institutionId}|${r.name}`;
      const l = day.get(k) ?? { start: minute(r.startsAt), inst: r.institutionId, name: r.name, backup: r.backup, people: [], open: 0 };
      if (r.participantId) l.people.push(r.participantId); else l.open++;
      day.set(k, l);
    }
    const first = addDays(iv.startDate, -dow(iv.startDate)), last = addDays(iv.endDate, 6 - dow(iv.endDate));
    const weeks = (dayDiff(first, last) + 1) / 7;
    let rn = 5;
    for (let w = 0; w < weeks; w++) {
      const dateRow = ws.getRow(rn++), body = ws.getRow(rn++);
      let most = 1;
      for (let j = 0; j < 7; j++) {
        const date = addDays(first, w * 7 + j), d = dayDiff(iv.startDate, date), inside = d >= 0 && date <= iv.endDate;
        const dc = dateRow.getCell(j + 1), bc = body.getCell(j + 1);
        dc.value = (date.getUTCDate() === 1 || (w === 0 && j === 0) || d === 0 ? `${MONTH[date.getUTCMonth()]} ${date.getUTCDate()}` : String(date.getUTCDate()))
          + (inside && academic.has(d) ? `   ${academic.get(d)!.join("; ")}` : "");
        dc.font = { bold: true, color: { argb: inside ? "FF0F172A" : "FFCBD5E1" } };
        dc.border = { ...thin, bottom: undefined };
        bc.border = { ...thin, top: undefined };
        bc.alignment = { vertical: "top", wrapText: true };
        if (inside && academic.has(d)) dc.fill = fill(ACADEMIC);
        if (!inside) { dc.fill = fill(GREY); bc.fill = fill(GREY); continue; }
        if (j >= 5) { bc.fill = fill(WEEKEND); if (!academic.has(d)) dc.fill = fill(WEEKEND); }
        const lines = [...(byDay.get(d)?.values() ?? [])].sort((a, b) => Number(a.backup) - Number(b.backup) || a.start - b.start
          || (instCode.get(a.inst) ?? "").localeCompare(instCode.get(b.inst) ?? "") || a.name.localeCompare(b.name));
        if (!lines.length) { bc.value = "No shifts"; bc.font = { color: { argb: MUTED }, size: 9 }; continue; }
        const parts: ExcelJS.RichText[] = [];
        lines.forEach((l, k) => {
          if (k) parts.push({ text: "\n" });
          if (showSite) parts.push({ text: `${instCode.get(l.inst)} `, font: { size: 9, color: { argb: MUTED } } });
          parts.push({ text: l.backup ? "Backup" : l.name, font: { size: 9, bold: true, color: { argb: l.backup ? "FF5B21B6" : "FF0F172A" } } });
          parts.push({ text: ` ${l.people.map(initialLast).join(", ")}`, font: { size: 9 } });
          if (l.open) parts.push({ text: `${l.people.length ? ", " : " "}${l.open > 1 ? `${l.open} open` : "OPEN"}`, font: { size: 9, bold: true, color: { argb: RED } } });
        });
        bc.value = { richText: parts };
        most = Math.max(most, lines.length);
      }
      dateRow.height = 16;
      body.height = Math.min(409, Math.max(30, most * 12.5 + 4));
    }
  }

  // ───────── Goals & checks ─────────
  {
    const ws = wb.addWorksheet("Goals & checks", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    heading(ws, title, `Generated ${sch.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
    ws.getColumn(1).width = 34; ws.getColumn(2).width = 22; ws.getColumn(3).width = 14; ws.getColumn(4).width = 12;
    ws.getColumn(5).width = 10; ws.getColumn(6).width = 10; ws.getColumn(7).width = 12; ws.getColumn(8).width = 14; ws.getColumn(9).width = 40;
    let rn = 4;
    const section = (text: string) => { rn += 1; const c = ws.getRow(rn++).getCell(1); c.value = text; c.font = { bold: true, size: 12 }; };
    const header = (cols: string[]) => { const r = ws.getRow(rn++); cols.forEach((h, j) => { const c = r.getCell(j + 1); c.value = h; c.font = { bold: true, size: 10 }; c.fill = fill(GREY); c.border = thin; c.alignment = { wrapText: true, vertical: "top" }; }); };
    const line = (vals: (string | number | null)[], opts: { red?: boolean; wrapLast?: boolean } = {}) => {
      const r = ws.getRow(rn++);
      vals.forEach((v, j) => { const c = r.getCell(j + 1); c.value = v; c.border = thin; c.alignment = { vertical: "top", horizontal: "left", wrapText: !!opts.wrapLast && j === vals.length - 1 }; if (opts.red) c.font = { color: { argb: RED } }; });
      return r;
    };
    const note = (text: string, red = false) => { const r = ws.getRow(rn++); ws.mergeCells(rn - 1, 1, rn - 1, 9); const c = r.getCell(1); c.value = text; c.alignment = { wrapText: true, vertical: "top" }; if (red) c.font = { color: { argb: RED } }; r.height = Math.max(15, Math.ceil(text.length / 150) * 15); };

    const violations: string[] = checks.violations;
    const under: string[] = rep?.validator?.under_contract_minimum ?? [];
    const openRows = rows.filter((r) => !r.participantId), extraUsed: number = rep?.validator?.extra_places_used ?? 0;
    const backupOpen = backupRows.filter((r) => !r.participantId).length;
    const requested = [...snapPeople.values()].reduce((a, r) => a + Object.keys(r.requests_off ?? {}).length, 0);
    const missed = [...stats.values()].reduce((a, r) => a + (r.requests_off_missed?.length ?? 0), 0);

    section("Summary");
    header(["", "Result"]);
    line(["Shifts filled", `${rows.length - openRows.length - extraUsed} of ${rows.length - extraUsed}${extraUsed ? ` (+ ${extraUsed} extra above a minimum headcount)` : ""}`]);
    line(["Open shifts", openRows.length], { red: openRows.length > 0 });
    line(["Hard rules", !rep ? "Not checked" : violations.length ? `${violations.length} broken` : "None broken"], { red: violations.length > 0 });
    line(["Below contract minimum", rep ? `${under.length} ${under.length === 1 ? "person" : "people"}` : "–"], { red: under.length > 0 });
    line(["Most hours in any 7 days", rep?.duty ? `${g(rep.duty.peak_rolling_7day_hours)}${snap?.rules?.max_week_hours ? ` of ${snap.rules.max_week_hours} allowed` : ""}` : "–"]);
    if (backupRows.length) line(["Backup days covered", `${backupRows.length - backupOpen} of ${backupRows.length}`], { red: backupOpen > 0 });
    line(["Request days granted", rep ? `${requested - missed} of ${requested}` : "–"]);

    if (violations.length) {
      section("Hard rules broken (this schedule cannot be published)");
      for (const v of violations) note(v, true);
      for (const c of checks.causes) note(c);
    }
    const pre: string[] = rep?.precheck?.errors ?? [];
    if (pre.length) { section("Before it started, the engine found that these inputs cannot be fully staffed"); for (const v of pre) note(v.replace(/\bresidents\b/g, "people")); }
    const past: string[] = rep?.past_notes ?? [];
    if (past.length) { section("From the previous interval's shifts"); for (const v of past) note(v); }

    section("Open shifts");
    if (!openRows.length) note("None. Every shift has the people it needs.");
    else {
      header(["Shift", "Date", "Time", "Open", "", "", "", "", "Why nobody else can take it"]);
      for (const o of (rep?.open ?? []) as Any[]) {
        const r = line([o.name, fmtDate(addDays(iv.startDate, o.cal)), `${hhmm(o.start)}–${hhmm(o.end)}`, `${o.missing} of ${o.need}`, null, null, null, null,
          (o.reasons as Any[]).map((q) => `${q.count} ${q.reason}${q.count <= 3 ? ` (${q.names.join(", ")})` : ""}`).join("; ")], { wrapLast: true });
        r.getCell(4).font = { color: { argb: RED } };
        ws.mergeCells(rn - 1, 5, rn - 1, 8);
      }
      if (!rep?.open) for (const r of openRows) line([r.name, fmtShort(r.dutyDate), span(r.startsAt, r.endsAt), "open"]);
    }

    if (rep?.backup) {
      section("Backup (on call)");
      const per = Object.values(rep.backup.per_resident as Record<string, number>);
      note(`Chosen after the clinical schedule was final, so backup never changes who works which shift. ${per.length ? `${Math.min(...per)} to ${Math.max(...per)} backup days per person.` : ""}`);
      if (!(rep.backup.open as Any[]).length) note("Every backup day is covered.");
      else for (const o of rep.backup.open as Any[]) note(`${o.name} · ${fmtDate(addDays(iv.startDate, o.day))}: nobody on backup. Why: ${(o.reasons as Any[]).map((q) => `${q.count} ${q.reason}${q.count <= 3 ? ` (${q.names.join(", ")})` : ""}`).join("; ")}`, true);
    }

    if (rep?.goals) {
      section("Goals, in priority order");
      note("The engine never gives up a goal higher in this list to improve one lower down. 0 means the goal is fully met; any other number is what is left over.");
      header(["Goal", "Result", "", "", "", "", "", "", "What the number counts"]);
      (rep.goals as Any[]).forEach((x, i) => {
        line([`${i + 1}. ${GOALS[x.name]?.label ?? x.name}`, x.score === 0 ? "Fully met" : `${g(x.score)} ${x.status === "optimal" ? "(proven best possible)" : "(best found in the time)"}`,
          null, null, null, null, null, null, GOALS[x.name]?.counts ?? ""], { wrapLast: true });
        ws.mergeCells(rn - 1, 2, rn - 1, 8);
        if (x.score === 0) ws.getRow(rn - 1).getCell(2).font = { color: { argb: "FF047857" } };
      });
    }

    if (rep?.residents) {
      section("Per person");
      header(["Participant", "Role", "Shifts", "Contract", "Hours", "Nights", "Weekend shifts", "Most hours in 7 days", "Request days not granted"]);
      for (const pid of ids.filter((p) => stats.has(p))) {
        const p = byId.get(pid)!, x = stats.get(pid);
        const r = line([full(pid), p.role.name, x.shifts, `${x.shifts_min}–${x.shifts_max}`, g(x.hours), x.nights, x.weekend_shifts, g(x.peak_rolling_7day_hours),
          x.requests_off_missed.length ? (x.requests_off_missed as number[]).map((d) => fmtShort(addDays(iv.startDate, d))).join(", ") : "–"]);
        if (x.shifts < x.shifts_min || x.shifts > x.shifts_max) r.getCell(3).font = { bold: true, color: { argb: RED } };
      }
    }

    section("How it was checked");
    if (rep?.validator) {
      note(`After the engine finished, a separate checker went through every person's shifts by the clock: hours in every rolling 7 days, rest after each shift, a 24-hour break each week, night limits, vacation, days off, academic time and eligibility. Result: ${violations.length === 0 ? "no hard rule broken" : `${violations.length} broken`}.`);
      for (const u of under) note(u, true);
      for (const w of (rep.precheck?.warnings ?? []) as string[]) note(`Capacity note: ${w}`);
      note(`Engine: ${rep.engine.backend === "cpsat" ? "OR-Tools CP-SAT" : "HiGHS"}, ${rep.engine.strategy === "full" ? "whole program at once" : "improved a part at a time"}, ${Number(rep.engine.decisions).toLocaleString("en-US")} yes/no decisions.`);
    } else note("This schedule was not made by the engine, so it has not been through the rule check.");
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `${iv.name}_${sch.label ?? "schedule"}`.replace(/[^\w-]+/g, "_") + ".xlsx";
  return { buffer, filename };
}
