import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...a: ClassValue[]) => twMerge(clsx(a));

// Dates without a time are stored as UTC midnight; everything here stays in UTC so a
// date never shifts by a day whatever the server's timezone is.
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
export const parseYmd = (s: string) => new Date(s + "T00:00:00.000Z");
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);
export const eachDay = (a: Date, b: Date) => Array.from({ length: Math.max(0, dayDiff(a, b) + 1) }, (_, i) => addDays(a, i));
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const dow = (d: Date) => (d.getUTCDay() + 6) % 7; // 0 = Monday
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (d: Date | null | undefined) =>
  d ? `${DOW[dow(d)]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : "";
export const fmtShort = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
export const fmtRange = (a: Date, b: Date) => (ymd(a) === ymd(b) ? fmtDate(a) : `${fmtShort(a)} – ${fmtShort(b)}, ${b.getUTCFullYear()}`);

// Times of day are minutes after midnight.
export const hhmm = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;
export const toMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};
export const fmtHours = (min: number) => `${+(min / 60).toFixed(2)}h`;
export const shiftTimes = (start: number, dur: number) =>
  `${hhmm(start)}–${hhmm(start + dur)}${start + dur > 1440 ? " (next day)" : ""}`;
export const overlaps = (a0: Date, a1: Date, b0: Date, b1: Date) => a0 <= b1 && b0 <= a1;
