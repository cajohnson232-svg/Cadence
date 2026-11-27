// Reads "how the previous interval ended" out of a spreadsheet: an .xlsx (or .csv) of the previous schedule.
//
// Three layouts are recognised, on any sheet (the sheet that yields the most shifts in the 7-day window wins):
//   • people by date  – one row per person, a date per column, a shift name or code in each cell
//                       (Cadence's own "By person" sheet, and most program schedule grids)
//   • shifts by date  – one row per shift, a date per column, who worked it in each cell
//                       (Cadence's "By shift" sheet)
//   • a list          – one shift per row with a person, a date and a shift in any column order
// Dates can be real Excel dates, 2027-01-11, 1/11/2027, 1/11, "Jan 11", or just a day number ("Mon 11"),
// in which case the month comes from a date range in the sheet's title or from the interval itself.
import ExcelJS from "exceljs";
import { addDays, dayDiff, ymd } from "@/lib/util";
import { shortCodes } from "@/lib/schedule-view";

export type Cell = string | number | Date | null;
export type Grid = { name: string; rows: Cell[][] };
export type Person = { id: string; firstName: string; lastName: string; email?: string | null };
export type ShiftDef = { id: string; name: string; institution: { name: string; shortCode: string } };
export type Found = { participantId: string; date: Date; shiftId: string };
export type ImportResult = {
  sheet: string; layout: string; found: Found[]; outside: number;
  problems: string[];            // things that could not be read, with counts, most frequent first
  fileDates: [Date, Date] | null; // the range of dates the sheet covers
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|sday|urday|rsday)?\b\.?/gi;
/** Cells that are not a shift: days off, vacation, backup, requests, blanks, open shifts. */
const IGNORE = new Set(["", "off", "vac", "vacation", "req", "bu", "backup", "open", "x", "-", "–", "—", "·", ".", "pto", "leave", "no shifts", "none"]);

export const text = (c: unknown): string => {
  if (c == null) return "";
  if (c instanceof Date) return ymd(c);
  if (typeof c === "object") {
    const o = c as { richText?: { text: string }[]; text?: unknown; result?: unknown };
    if (o.richText) return o.richText.map((x) => x.text).join("");
    if (o.result !== undefined) return text(o.result);
    if (o.text !== undefined) return text(o.text);
    return "";
  }
  return String(c).trim();
};
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.'’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const squash = (s: string) => norm(s).replace(/ /g, "");
/** Codes keep their symbols: Cadence's "DM" and "DM*" are different shifts. */
const codeKey = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// ───────── dates ─────────
type DatePart = { date?: Date; month?: number; dom?: number };
const utc = (y: number, m: number, d: number) => {
  const x = new Date(Date.UTC(y, m, d));
  return x.getUTCMonth() === m && x.getUTCDate() === d ? x : undefined;
};
/** A header cell as a date, a month and day, or a day of the month; null if it is not a date. */
export function datePart(c: Cell): DatePart | null {
  if (c instanceof Date) return { date: new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate())) };
  if (typeof c === "number") {
    if (c >= 30000 && c < 80000) return { date: addDays(new Date(Date.UTC(1899, 11, 30)), Math.floor(c)) }; // Excel serial date
    return Number.isInteger(c) && c >= 1 && c <= 31 ? { dom: c } : null;
  }
  let s = text(c).toLowerCase().replace(WEEKDAY, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t].*)?$/))) { const d = utc(+m[1], +m[2] - 1, +m[3]); return d ? { date: d } : null; }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { const d = utc(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]); return d ? { date: d } : null; }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) return +m[1] <= 12 && +m[2] <= 31 ? { month: +m[1] - 1, dom: +m[2] } : null;
  s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if ((m = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)) && MONTHS.includes(m[1])) {
    const mo = MONTHS.indexOf(m[1]);
    if (m[3]) { const d = utc(+m[3], mo, +m[2]); return d ? { date: d } : null; }
    return { month: mo, dom: +m[2] };
  }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[ -]([a-z]{3})[a-z]*\.?(?:[ -](\d{2,4}))?$/)) && MONTHS.includes(m[2])) {
    const mo = MONTHS.indexOf(m[2]);
    if (m[3]) { const d = utc(+m[3] < 100 ? 2000 + +m[3] : +m[3], mo, +m[1]); return d ? { date: d } : null; }
    return { month: mo, dom: +m[1] };
  }
  if ((m = s.match(/^(\d{1,2})$/)) && +m[1] >= 1 && +m[1] <= 31) return { dom: +m[1] };
  return null;
}
/** "Jan 4 – Jan 31, 2027" (or 1/4/2027 - 1/31/2027) anywhere in the text: its first date. */
function rangeStart(s: string): Date | undefined {
  const t = s.toLowerCase();
  let m = t.match(/\b([a-z]{3})[a-z]* (\d{1,2})\s*[–—-]\s*([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})/);
  if (m && MONTHS.includes(m[1]) && MONTHS.includes(m[3])) {
    const y = +m[5], m1 = MONTHS.indexOf(m[1]), m2 = MONTHS.indexOf(m[3]);
    return utc(m1 > m2 ? y - 1 : y, m1, +m[2]);
  }
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[–—-]/);
  if (m) return utc(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
  return undefined;
}
/** The year that puts month/day nearest to `near`. */
const nearest = (month: number, dom: number, near: Date) =>
  [near.getUTCFullYear() - 1, near.getUTCFullYear(), near.getUTCFullYear() + 1].map((y) => utc(y, month, dom)).filter((d): d is Date => !!d)
    .sort((a, b) => Math.abs(dayDiff(a, near)) - Math.abs(dayDiff(b, near)))[0];

/** Turn a row of header cells into dates, column by column (undefined where a column is not a date). */
function resolveDates(parts: (DatePart | null)[], titleText: string, endsBefore: Date): (Date | undefined)[] | null {
  const cols = parts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (cols.length < 2) return null;
  const out: (Date | undefined)[] = parts.map(() => undefined);
  for (const i of cols) {
    const p = parts[i]!;
    out[i] = p.date ?? (p.month !== undefined && p.dom !== undefined ? nearest(p.month, p.dom, endsBefore) : undefined);
  }
  // day numbers only: walk forward from a known date, a range in the title, or (last resort) the day before the interval
  const advance = (from: Date, dom: number) => { for (let k = 0; k < 7; k++) { const d = addDays(from, k); if (d.getUTCDate() === dom) return d; } return undefined; };
  const known = cols.find((i) => out[i]);
  if (cols.some((i) => !out[i])) {
    let start: Date | undefined;
    if (known !== undefined) {
      // propagate both ways from the first known date, one column = one day
      for (let k = cols.indexOf(known) + 1; k < cols.length; k++) if (!out[cols[k]]) out[cols[k]] = advance(addDays(out[cols[k - 1]]!, 1), parts[cols[k]]!.dom!);
      for (let k = cols.indexOf(known) - 1; k >= 0; k--) if (!out[cols[k]]) { const want = parts[cols[k]]!.dom!; for (let j = 1; j <= 7; j++) { const d = addDays(out[cols[k + 1]]!, -j); if (d.getUTCDate() === want) { out[cols[k]] = d; break; } } }
    } else if ((start = rangeStart(titleText)) && start.getUTCDate() === parts[cols[0]]!.dom) {
      out[cols[0]] = start;
      for (let k = 1; k < cols.length; k++) out[cols[k]] = advance(addDays(out[cols[k - 1]]!, 1), parts[cols[k]]!.dom!);
    } else {
      const last = addDays(endsBefore, -1), at = [...cols].reverse().find((i) => parts[i]!.dom === last.getUTCDate());
      if (at === undefined) return null;
      out[at] = last;
      for (let k = cols.indexOf(at) - 1; k >= 0; k--) { const want = parts[cols[k]]!.dom!; for (let j = 1; j <= 7; j++) { const d = addDays(out[cols[k + 1]]!, -j); if (d.getUTCDate() === want) { out[cols[k]] = d; break; } } }
      for (let k = cols.indexOf(at) + 1; k < cols.length; k++) out[cols[k]] = advance(addDays(out[cols[k - 1]]!, 1), parts[cols[k]]!.dom!);
    }
  }
  return out;
}

// ───────── people and shifts ─────────
export function matchers(people: Person[], shifts: ShiftDef[], legend: Map<string, string> = new Map()) {
  const byKey = new Map<string, Set<string>>();
  const add = (k: string, id: string) => { if (!k) return; const s = byKey.get(k) ?? new Set(); s.add(id); byKey.set(k, s); };
  for (const p of people) {
    const f = norm(p.firstName), l = norm(p.lastName);
    for (const k of [`${f} ${l}`, `${l} ${f}`, l, `${f[0]} ${l}`, `${l} ${f[0]}`, p.email ? norm(p.email.split("@")[0]) : ""]) add(k, p.id);
  }
  const person = (s: string): { id?: string; why?: string } => {
    const ids = byKey.get(norm(s));
    if (!ids) return { why: "nobody by that name" };
    if (ids.size > 1) return { why: "more than one person by that name" };
    return { id: [...ids][0] };
  };
  const byName = new Map<string, ShiftDef[]>();
  for (const s of shifts) byName.set(squash(s.name), [...(byName.get(squash(s.name)) ?? []), s]);
  const codes = shortCodes(shifts.map((s) => s.name));
  const byCode = new Map<string, ShiftDef[]>();
  for (const s of shifts) { const c = codeKey(codes.get(s.name) ?? ""); byCode.set(c, [...(byCode.get(c) ?? []), s]); }
  // names as words, longest first, for cells that add to a shift's name ("Holiday Day M", "Day GP (retreat)")
  const words = [...byName.keys()].map((k) => ({ k, re: new RegExp(`(^| )${norm([...byName.get(k)!][0].name).replace(/ /g, " ?")}( |$)`) }))
    .sort((a, b) => b.k.length - a.k.length);
  const shift = (s: string, site?: string): { s?: ShiftDef; why?: string } => {
    const k = squash(s);
    const pick = (list?: ShiftDef[]) => {
      if (!list?.length) return undefined;
      const here = site ? list.filter((x) => squash(x.institution.shortCode) === squash(site) || squash(x.institution.name) === squash(site)) : list;
      return here.length === 1 ? here[0] : list.length === 1 ? list[0] : null;
    };
    const legendName = legend.get(codeKey(s));
    const exact = (name: string) => pick(byName.get(squash(name)));
    const within = (name: string) => { const n = norm(name.replace(/\(.*?\)/g, " ")); const w = words.find((x) => x.re.test(n)); return w ? pick(byName.get(w.k)) : undefined; };
    const hit = exact(s) ?? (legendName ? exact(legendName) ?? within(legendName) : undefined) ?? pick(byCode.get(codeKey(s))) ?? within(s);
    if (hit === null) return { why: "more than one shift by that name" };
    return hit ? { s: hit } : { why: "not a shift here" };
  };
  return { person, shift };
}

// ───────── reading a sheet ─────────
class Tally {
  m = new Map<string, number>();
  add(k: string) { this.m.set(k, (this.m.get(k) ?? 0) + 1); }
  list() { return [...this.m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k} (${n} cells)` : k)); }
}

/** A code key such as Cadence's ("GPEU" → "Gold Pod Evening - Upper · LBJ · 14:00–22:00"): code → shift name. */
function readLegend(g: Grid, shiftNames: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of g.rows) {
    const a = text(r?.[0]), b = text(r?.[1]);
    if (!a || !b || a.length > 8 || /\s/.test(a)) continue;
    const name = b.split(" · ")[0].trim();
    if (shiftNames.has(squash(name)) || /\d{2}:\d{2}[–-]\d{2}:\d{2}/.test(b)) out.set(codeKey(a), name);
  }
  return out;
}

export function readSheet(g: Grid, people: Person[], shifts: ShiftDef[], window: { from: Date; to: Date }, intervalStart: Date): ImportResult {
  const legend = readLegend(g, new Set(shifts.map((s) => squash(s.name))));
  const M = matchers(people, shifts, legend);
  const bad = new Tally(), found: Found[] = [];
  let outside = 0, first: Date | undefined, last: Date | undefined;
  const seen = (d: Date) => { if (!first || d < first) first = d; if (!last || d > last) last = d; };
  const keep = (participantId: string, date: Date, shiftId: string) => {
    seen(date);
    if (date < window.from || date > window.to) { outside++; return; }
    found.push({ participantId, date, shiftId });
  };
  const titleText = g.rows.slice(0, 4).map((r) => (r ?? []).map(text).join(" ")).join(" ");

  // a header row of dates?
  let header = -1, dates: (Date | undefined)[] | null = null;
  for (let i = 0; i < Math.min(g.rows.length, 20); i++) {
    const parts = (g.rows[i] ?? []).map((c) => datePart(c));
    if (parts.filter(Boolean).length < 3) continue;
    const d = resolveDates(parts, titleText, intervalStart);
    if (d && d.filter(Boolean).length >= 3) { header = i; dates = d; break; }
  }

  if (header >= 0 && dates) {
    const firstDateCol = dates.findIndex(Boolean);
    // which column names the row, and is it a person or a shift?
    let best = { col: 0, kind: "person" as "person" | "shift", hits: 0 };
    for (let c = 0; c < firstDateCol; c++) for (const kind of ["person", "shift"] as const) {
      let hits = 0;
      for (const r of g.rows.slice(header + 1)) { const t = text(r?.[c]); if (t && (kind === "person" ? M.person(t).id : M.shift(t).s)) hits++; }
      if (hits > best.hits) best = { col: c, kind, hits };
    }
    if (best.hits > 0) {
      let site: string | undefined;
      const sites = new Set(shifts.flatMap((s) => [squash(s.institution.name), squash(s.institution.shortCode)]));
      for (const r of g.rows.slice(header + 1)) {
        const label = text(r?.[best.col]);
        if (!label || IGNORE.has(norm(label))) continue;   // e.g. Cadence's "Backup" row: on call, not a worked shift
        const cells = dates.map((d, c) => (d ? { d, t: text(r?.[c]) } : null)).filter((x): x is { d: Date; t: string } => !!x);
        if (sites.has(squash(label)) && cells.every((x) => !x.t)) { site = label; continue; } // an institution heading
        if (best.kind === "person") {
          const p = M.person(label);
          if (!p.id) { if (cells.some((x) => x.t && !IGNORE.has(norm(x.t)))) bad.add(`"${label}": ${p.why}`); continue; }
          for (const { d, t } of cells) for (const tok of t.split(/\n|\/|;|,/).map((x) => x.trim().replace(/\+$/, ""))) {
            if (IGNORE.has(norm(tok))) continue;
            const s = M.shift(tok);
            if (s.s) keep(p.id, d, s.s.id); else if (d >= window.from && d <= window.to) bad.add(`"${tok}": ${s.why}`);
          }
        } else {
          const s = M.shift(label, site);
          if (!s.s) { if (cells.some((x) => x.t && !IGNORE.has(norm(x.t)))) bad.add(`"${label}": ${s.why}`); continue; }
          for (const { d, t } of cells) for (const tok of t.split(/\n|;|,|\//).map((x) => x.trim())) {
            if (IGNORE.has(norm(tok))) continue;
            const p = M.person(tok);
            if (p.id) keep(p.id, d, s.s.id); else if (d >= window.from && d <= window.to) bad.add(`"${tok}": ${p.why}`);
          }
        }
      }
      return { sheet: g.name, layout: best.kind === "person" ? "one row per person, a date per column" : "one row per shift, a date per column",
        found, outside, problems: bad.list(), fileDates: first && last ? [first, last] : null };
    }
  }

  // a list: each row has a person, a date and a shift somewhere
  for (const r of g.rows) {
    const cells = (r ?? []).map((c) => ({ c, t: text(c) })).filter((x) => x.t);
    if (cells.length < 3) continue;
    let pid: string | undefined, date: Date | undefined, sh: ShiftDef | undefined;
    for (const { c, t } of cells) {
      if (!date) { const dp = datePart(c); const d = dp?.date ?? (dp?.month !== undefined && dp.dom !== undefined ? nearest(dp.month, dp.dom, intervalStart) : undefined); if (d) { date = d; continue; } }
      if (!pid) { const p = M.person(t); if (p.id) { pid = p.id; continue; } }
      if (!sh) { const s = M.shift(t); if (s.s) { sh = s.s; continue; } }
    }
    if (pid && date && sh) keep(pid, date, sh.id);
    else if (date && date >= window.from && date <= window.to && (pid || sh)) bad.add(`row "${cells.map((x) => x.t).join(", ")}": ${!pid ? "no person recognised" : "no shift recognised"}`);
  }
  return { sheet: g.name, layout: "one shift per row", found, outside, problems: bad.list(), fileDates: first && last ? [first, last] : null };
}

/** Every sheet of an .xlsx (or the one table of a .csv) as plain grids. */
export async function readGrids(buf: Buffer, filename: string): Promise<Grid[]> {
  if (/\.csv$/i.test(filename)) {
    const rows: Cell[][] = [];
    for (const line of buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const out: string[] = []; let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
      }
      out.push(cur);
      rows.push(out);
    }
    return [{ name: filename, rows }];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        const v = cell.value as unknown;
        // merged cells: only the master holds the value
        const val = cell.isMerged && cell.master !== cell ? null : v;
        cells[cn - 1] = val instanceof Date || typeof val === "number" ? val : val == null ? null : text(val);
      });
      rows[rn - 1] = cells;
    });
    return { name: ws.name, rows };
  });
}

/** Read the file and keep the sheet that gives the most shifts in the window. */
export async function importPrior(buf: Buffer, filename: string, people: Person[], shifts: ShiftDef[], window: { from: Date; to: Date }, intervalStart: Date): Promise<ImportResult | null> {
  const grids = await readGrids(buf, filename);
  const results = grids.map((g) => readSheet(g, people, shifts, window, intervalStart));
  return results.sort((a, b) => b.found.length - a.found.length || a.problems.length - b.problems.length)[0] ?? null;
}
