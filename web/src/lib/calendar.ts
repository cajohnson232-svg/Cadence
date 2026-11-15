// The personal calendar export: published shifts, plus academic time as a reminder.
// Served as an iCalendar feed that Google, Apple and Outlook calendars can subscribe to.
import { db } from "./db";
import { academicSessions, attends } from "./domain";
import { addDays, hhmm, ymd } from "./util";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15); // wall-clock, read with TZID
const local = (day: Date, minute: number) => ymd(addDays(day, Math.floor(minute / 1440))).replace(/-/g, "") + "T" + hhmm(minute).replace(":", "") + "00";

export async function calendarFor(token: string): Promise<{ ics: string; events: number; name: string } | null> {
  const p = await db.participant.findUnique({ where: { calendarToken: token }, include: { program: true } });
  if (!p || p.archivedAt) return null;
  const shifts = await db.scheduledShift.findMany({
    where: { participantId: p.id, schedule: { status: "PUBLISHED" } }, include: { institution: true }, orderBy: { startsAt: "asc" },
  });
  const published = await db.interval.findMany({ where: { programId: p.programId, status: "PUBLISHED" }, orderBy: { startDate: "asc" } });
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cadence//Schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`${p.program.name} schedule`)}`, `X-WR-TIMEZONE:${p.program.timezone}`];
  let events = 0;
  for (const s of shifts) {
    out.push("BEGIN:VEVENT", `UID:shift-${s.id}@cadence`, `DTSTAMP:${now}`, `DTSTART;TZID=${s.institution.timezone}:${stamp(s.startsAt)}`,
      `DTEND;TZID=${s.institution.timezone}:${stamp(s.endsAt)}`, `SUMMARY:${esc(s.name)}`, `LOCATION:${esc(s.institution.name)}`, "END:VEVENT");
    events++;
  }
  if (published.length) {
    const sessions = await academicSessions(p.programId, published[0].startDate, published[published.length - 1].endDate);
    for (const a of sessions) {
      if (!attends(a, p) || !published.some((i) => i.startDate <= a.date && a.date <= i.endDate)) continue;
      out.push("BEGIN:VEVENT", `UID:academic-${a.academicDayId}-${ymd(a.date)}@cadence`, `DTSTAMP:${now}`, `DTSTART;TZID=${p.program.timezone}:${local(a.date, a.startMinute)}`,
        `DTEND;TZID=${p.program.timezone}:${local(a.date, a.startMinute + a.durationMinutes)}`, `SUMMARY:${esc(a.name)}`, "CATEGORIES:Academic", "TRANSP:OPAQUE", "END:VEVENT");
      events++;
    }
  }
  out.push("END:VCALENDAR");
  return { ics: out.join("\r\n") + "\r\n", events, name: `${p.firstName} ${p.lastName}` };
}
