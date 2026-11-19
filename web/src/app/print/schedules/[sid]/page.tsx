// A schedule's calendar on its own, for printing or saving as a PDF: one institution, all of them together,
// or every view in turn (?site=each), each on its own landscape page.
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { categoryColors } from "@/lib/schedule-view";
import { fmtRange } from "@/lib/util";
import { ScheduleCalendar, calendarScope } from "@/components/schedule-calendar";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Schedule calendar" };

export default async function PrintCalendar({ params, searchParams }: { params: Promise<{ sid: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const { sid } = await params;
  const sp = await searchParams;
  const sch = await db.schedule.findFirst({ where: { id: sid, interval: { programId: s.programId }, runStatus: "DONE" }, include: { interval: true } });
  if (!sch) notFound();
  const [rows, cats, people, instAll, program] = await Promise.all([
    db.scheduledShift.findMany({ where: { scheduleId: sid }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] }),
    db.shiftCategory.findMany({ where: { programId: s.programId } }),
    db.participant.findMany({ where: { programId: s.programId } }),
    db.institution.findMany({ where: { programId: s.programId }, orderBy: { shortCode: "asc" } }),
    db.program.findUniqueOrThrow({ where: { id: s.programId } }),
  ]);
  const used = new Set(rows.map((r) => r.institutionId));
  const insts = instAll.filter((i) => used.has(i.id)).map((i) => ({ id: i.id, shortCode: i.shortCode, name: i.name }));
  const scopes = sp.site === "each" ? [calendarScope("all", insts), ...(insts.length > 1 ? insts.map((i) => calendarScope(i.id, insts)) : [])] : [calendarScope(sp.site, insts)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = sch.inputSnapshot as any;
  const n = Math.round((sch.interval.endDate.getTime() - sch.interval.startDate.getTime()) / 86400000) + 1;
  const academic = new Map<number, string[]>();
  for (const a of (snap?.academic_time ?? []) as { day: number; name: string; start: string; hours: number; also_attend?: string[]; pgy?: number[] }[])
    if (a.day >= 0 && a.day < n && !(a.pgy?.length === 1 && a.pgy[0] === -1)) academic.set(a.day, [...(academic.get(a.day) ?? []), `${a.name} ${a.start} (${a.hours}h)`]);
  const status = sch.status === "PUBLISHED" ? "Published" : sch.status === "DRAFT" ? "Draft" : "Replaced";
  return (
    <div className="mx-auto max-w-[1400px] bg-white p-6 print:max-w-none print:p-0">
      <style>{"@page { size: landscape; margin: 8mm; } @media print { body { background: white; } }"}</style>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <p className="text-sm text-muted">{scopes.length > 1 ? `${scopes.length} views, each on its own page.` : "One view."} Use Print, then choose your printer or &quot;Save as PDF&quot;.</p>
        <PrintButton />
      </div>
      {scopes.map((scope, i) => (
        <section key={scope.key} className={i ? "mt-10 break-before-page print:mt-0" : ""} data-testid="print-view">
          <header className="mb-2 flex items-baseline justify-between gap-4">
            <h1 className="text-lg font-semibold">{program.name} · {sch.interval.name}: {scope.title}</h1>
            <p className="text-xs text-muted">{fmtRange(sch.interval.startDate, sch.interval.endDate)} · {sch.label ?? "Schedule"} ({status})</p>
          </header>
          <ScheduleCalendar start={sch.interval.startDate} end={sch.interval.endDate} rows={rows} people={new Map(people.map((p) => [p.id, p]))} insts={insts} scope={scope}
            colors={categoryColors(cats)} nightCats={new Set(cats.filter((c) => c.isNight).map((c) => c.id))} academic={academic} />
        </section>
      ))}
    </div>
  );
}
