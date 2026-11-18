// One participant: choose an interval, then set up everything about them for it.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  addAdjustment, addPersonalAcademic, addRequiredOff, assignToInterval, deleteAdjustment, deletePersonalAcademic, deleteTimeOff,
  removeFromInterval, saveInstitutions, savePreferences,
} from "@/app/assignment-actions";
import { InstitutionsForm } from "@/components/institutions-form";
import { Flash } from "@/components/entity-pages";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge, Card, Notice, td, th } from "@/components/ui/misc";
import { DOW, cn, fmtDate, fmtRange, hhmm, shiftTimes, ymd } from "@/lib/util";

type SP = Record<string, string | undefined>;

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 max-w-3xl text-sm text-muted">{hint}</p>}
      <Card className="mt-2 p-4">{children}</Card>
    </section>
  );
}
const Remove = ({ action, label }: { action: () => Promise<void>; label: string }) => (
  <form action={action} className="inline"><button className="text-xs text-red-700 hover:underline" aria-label={label}>Remove</button></form>
);

export default async function ParticipantAssignment({ params, searchParams }: { params: Promise<{ pid: string }>; searchParams: Promise<SP> }) {
  const s = await requireAdmin();
  const { pid } = await params;
  const sp = await searchParams;
  const p = await db.participant.findFirst({ where: { id: pid, programId: s.programId }, include: { role: true } });
  if (!p) notFound();
  const intervals = await db.interval.findMany({ where: { programId: s.programId }, orderBy: { startDate: "desc" } });
  const iv = intervals.find((i) => i.id === sp.interval) ?? intervals.find((i) => i.status !== "PUBLISHED") ?? intervals[0];
  const name = `${p.firstName} ${p.lastName}`;
  const head = (
    <div className="mb-4">
      <Link href="/assignments" className="text-sm text-brand hover:underline">← Assignments</Link>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">{name}</h1>
      <p className="mt-0.5 text-sm text-muted">{p.role.name}{p.email ? ` · ${p.email}` : ""} · <Link href={`/participants/${p.id}`} className="text-brand hover:underline">Participant record</Link></p>
    </div>
  );
  if (!iv) return <>{head}<Notice tone="amber">There are no intervals yet. Create one under Intervals first.</Notice></>;

  const pick = (
    <form className="mb-5 flex flex-wrap items-end gap-3" data-testid="interval-picker">
      <label className="text-sm"><span className="mb-1 block font-medium">Interval</span>
        <Select name="interval" defaultValue={iv.id} className="w-72">{intervals.map((i) => <option key={i.id} value={i.id}>{i.name} ({fmtRange(i.startDate, i.endDate)})</option>)}</Select></label>
      <Button variant="outline">Open</Button>
    </form>
  );
  const a = await db.assignment.findFirst({ where: { participantId: pid, startDate: { lte: iv.endDate }, endDate: { gte: iv.startDate } }, include: { institutions: true }, orderBy: { startDate: "asc" } });
  if (!a) return (
    <>{head}{pick}<Flash sp={sp} />
      <Card className="p-5" data-testid="not-assigned">
        <p className="text-sm">{name} is not assigned to <strong>{iv.name}</strong> ({fmtRange(iv.startDate, iv.endDate)}).</p>
        <p className="mt-1 text-sm text-muted">Assigning them covers the whole interval, with the {p.role.name} number of shifts and every institution; you can narrow it down next.</p>
        <form action={assignToInterval.bind(null, pid, iv.id)} className="mt-3"><Button>Assign to {iv.name}</Button></form>
      </Card>
    </>
  );

  const [insts, adjustments, offs, personal, shifts, roleRows] = await Promise.all([
    db.institution.findMany({ where: { programId: s.programId, archivedAt: null }, orderBy: { name: "asc" } }),
    db.shiftAdjustment.findMany({ where: { participantId: pid, intervalId: iv.id }, orderBy: { createdAt: "asc" } }),
    db.timeOff.findMany({ where: { participantId: pid, startDate: { lte: iv.endDate }, endDate: { gte: iv.startDate } }, orderBy: { startDate: "asc" } }),
    db.academicDay.findMany({ where: { participantId: pid, archivedAt: null, OR: [{ startDate: null }, { startDate: { lte: iv.endDate } }], AND: [{ OR: [{ endDate: null }, { endDate: { gte: iv.startDate } }] }] }, include: { occurrences: true }, orderBy: { dayOfWeek: "asc" } }),
    db.shift.findMany({ where: { programId: s.programId, active: true, archivedAt: null }, include: { institution: true, category: true }, orderBy: [{ institutionId: "asc" }, { startMinute: "asc" }] }),
    db.shiftRole.findMany({ where: { roleId: p.roleId } }),
  ]);
  const at = new Map(a.institutions.map((i) => [i.institutionId, i]));
  const delta = adjustments.reduce((t, x) => t + x.delta, 0);
  const baseMin = a.minShifts ?? p.role.defaultMinShifts, baseMax = a.maxShifts ?? p.role.defaultMaxShifts;
  const range = (lo: number | null, hi: number | null) => (lo == null || hi == null ? "not set" : lo === hi ? `${lo}` : `${lo}–${hi}`);
  const eligibleRole = new Map(roleRows.map((r) => [r.shiftId, r.eligible]));
  const eligible = shifts.filter((x) => (eligibleRole.get(x.id) ?? true) && at.has(x.institutionId));
  const clinical = eligible.filter((x) => !x.isBackup && !(a.noNights && x.category.isNight));
  const backups = eligible.filter((x) => x.isBackup);
  const required = offs.filter((t) => t.kind === "REQUIRED_OFF");
  const others = offs.filter((t) => t.kind !== "REQUIRED_OFF");
  const partial = a.startDate > iv.startDate || a.endDate < iv.endDate;

  return (
    <>
      {head}{pick}<Flash sp={sp} />
      <Card className="mb-6 p-4" data-testid="assignment-summary">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-sm">
            <p><span className="font-medium">{iv.name}:</span> {partial ? `${fmtRange(a.startDate, a.endDate)} (an older assignment covering part of the interval)` : `the whole interval, ${fmtRange(iv.startDate, iv.endDate)}`}</p>
            <p data-testid="shift-count"><span className="font-medium">Shifts:</span> {range(baseMin, baseMax)} {a.minShifts == null ? `(the ${p.role.name} default)` : "(set on this assignment before shift counts came from the role)"}
              {delta !== 0 && baseMin != null && baseMax != null && <> {delta > 0 ? "+" : "−"} {Math.abs(delta)} adjustment = <strong>{range(Math.max(0, baseMin + delta), Math.max(0, baseMax + delta))}</strong></>}</p>
            {baseMin == null && <p className="text-amber-800">The {p.role.name} role has no default number of shifts. <Link href={`/roles/${p.roleId}`} className="underline">Set it under Roles</Link>.</p>}
            <p><span className="font-medium">Can work:</span> {clinical.length} shift type{clinical.length === 1 ? "" : "s"} ({p.role.name} at {a.institutions.map((i) => insts.find((x) => x.id === i.institutionId)?.shortCode).join(", ")}{a.noNights ? ", no nights" : ""}){backups.length ? `, and ${backups.map((b) => b.name).join(", ")} (on call)` : ""}.</p>
          </div>
          <form action={removeFromInterval.bind(null, pid, iv.id)}><Button variant="outline" size="sm">Remove from {iv.name}</Button></form>
        </div>
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted">Which shifts</summary>
          <ul className="mt-1 columns-2 text-xs text-muted md:columns-3">{clinical.map((x) => <li key={x.id}>{x.institution.shortCode} · {x.name} · {shiftTimes(x.startMinute, x.durationMinutes)}</li>)}</ul>
        </details>
      </Card>

      <div className="space-y-6">
        <Section id="institutions" title="Institutions" hint="Where they may work in this interval.">
          <InstitutionsForm action={saveInstitutions.bind(null, pid, iv.id)} min={ymd(iv.startDate)} max={ymd(iv.endDate)}
            rows={insts.map((i) => ({ id: i.id, name: i.name, code: i.shortCode, on: at.has(i.id), pct: at.get(i.id)?.sharePercent ?? null, from: ymd(at.get(i.id)?.startDate), until: ymd(at.get(i.id)?.endDate) }))} />
        </Section>

        <Section id="adjustments" title="Adjustments" hint="Extra shifts or a reduction for this interval, on top of the role's number.">
          {adjustments.length > 0 && (
            <table className="mb-3 w-full" data-testid="adjustment-list"><tbody className="divide-y divide-line">
              {adjustments.map((x) => (
                <tr key={x.id}><td className={cn(td, "w-20 font-semibold tabular-nums")}>{x.delta > 0 ? "+" : ""}{x.delta}</td><td className={td}>{x.reason || <span className="text-muted">No reason given</span>}</td>
                  <td className={cn(td, "text-right")}><Remove action={deleteAdjustment.bind(null, pid, iv.id, x.id)} label={`Remove adjustment ${x.delta}`} /></td></tr>
              ))}
            </tbody></table>
          )}
          <form action={addAdjustment.bind(null, pid, iv.id)} className="flex flex-wrap items-end gap-3">
            <div><Label htmlFor="delta">Shifts (+ or −)</Label><Input id="delta" name="delta" type="number" min={-31} max={31} step={1} placeholder="-2" className="w-28" required /></div>
            <div className="min-w-64 flex-1"><Label htmlFor="reason">Reason (optional)</Label><Input id="reason" name="reason" placeholder="Chief duties" /></div>
            <Button size="sm" variant="outline">Add adjustment</Button>
          </form>
        </Section>

        <h2 className="pt-2 text-lg font-semibold tracking-tight">Time off and preferences</h2>

        <Section id="time-off" title="Required time off" hint="Dates, or times on those dates, when they must not be scheduled. Always enforced, whatever the request allowance. For last-minute changes.">
          {required.length > 0 && (
            <table className="mb-3 w-full" data-testid="required-off-list"><tbody className="divide-y divide-line">
              {required.map((t) => (
                <tr key={t.id}>
                  <td className={td}>{fmtRange(t.startDate, t.endDate)}</td>
                  <td className={td}>{t.startMinute != null && t.endMinute != null ? `${hhmm(t.startMinute)}–${hhmm(t.endMinute)}${t.startDate < t.endDate ? " each day" : ""}` : "Whole day"}</td>
                  <td className={td}>{t.reason ?? ""}</td>
                  <td className={cn(td, "text-right")}><Remove action={deleteTimeOff.bind(null, pid, iv.id, t.id)} label={`Remove time off ${ymd(t.startDate)}`} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
          <form action={addRequiredOff.bind(null, pid, iv.id)} className="grid items-end gap-3 sm:grid-cols-[auto_auto_auto_auto_auto_1fr_auto]">
            <div><Label htmlFor="off-from">From</Label><Input id="off-from" name="from" type="date" min={ymd(iv.startDate)} max={ymd(iv.endDate)} required className="w-40" /></div>
            <div><Label htmlFor="off-until">Until (optional)</Label><Input id="off-until" name="until" type="date" min={ymd(iv.startDate)} max={ymd(iv.endDate)} className="w-40" /></div>
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="wholeDay" defaultChecked className="size-4" />Whole day</label>
            <div><Label htmlFor="off-start">or from</Label><Input id="off-start" name="startTime" type="time" className="w-28" /></div>
            <div><Label htmlFor="off-end">to</Label><Input id="off-end" name="endTime" type="time" className="w-28" /></div>
            <div><Label htmlFor="off-reason">Reason (optional)</Label><Input id="off-reason" name="reason" /></div>
            <Button size="sm" variant="outline">Add</Button>
          </form>
          <p className="mt-2 text-xs text-muted">For a time window, untick &quot;Whole day&quot; and enter the times; they apply on each date in the range.</p>
          {others.length > 0 && (
            <p className="mt-3 text-sm text-muted" data-testid="other-time-off">Also this interval: {others.map((t) => `${t.kind === "VACATION" ? "vacation" : "request off"} ${fmtRange(t.startDate, t.endDate)}${t.status !== "APPROVED" ? ` (${t.status.toLowerCase()})` : ""}`).join("; ")}.{" "}
              <Link href={`/intervals/${iv.id}?tab=requests`} className="text-brand hover:underline">Requests &amp; vacations</Link></p>
          )}
        </Section>

        <Section id="preferences" title="No nights, and notes">
          <form action={savePreferences.bind(null, pid, iv.id)} className="space-y-3">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="noNights" defaultChecked={a.noNights} className="mt-0.5 size-4" />
              <span><span className="font-medium">No nights</span> <span className="text-muted">— cannot be given any night shift this interval (for example for medical or religious reasons). Always enforced.</span></span></label>
            <div><Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={3} defaultValue={a.notes ?? ""} placeholder="Why these settings: for your records. Shown with the compiled rules and given to the AI when it explains a schedule." /></div>
            <Button size="sm" variant="outline">Save</Button>
          </form>
        </Section>

        <Section id="academic" title="Personal academic days" hint="Recurring protected time for this person only, set up like the program's academic days.">
          {personal.length > 0 && (
            <table className="mb-3 w-full" data-testid="personal-academic-list">
              <thead className="border-b border-line"><tr>{["Name", "When", "Dates", "If a shift overlaps", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {personal.map((x) => (
                  <tr key={x.id}>
                    <td className={td}>{x.name}</td><td className={td}>{DOW[x.dayOfWeek]} {shiftTimes(x.startMinute, x.durationMinutes)}</td>
                    <td className={td}>{x.startDate && x.endDate ? fmtRange(x.startDate, x.endDate) : "Ongoing"}
                      {x.occurrences.some((o) => o.cancelled) && <div className="text-xs text-muted">Not on {x.occurrences.filter((o) => o.cancelled).map((o) => fmtDate(o.date)).join(", ")}</div>}</td>
                    <td className={td}>{x.overlapPolicy === "BLOCKED" ? <Badge tone="blue">Cannot work it</Badge> : <Badge>Can work it</Badge>}</td>
                    <td className={cn(td, "text-right")}><Remove action={deletePersonalAcademic.bind(null, pid, iv.id, x.id)} label={`Remove ${x.name}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form action={addPersonalAcademic.bind(null, pid, iv.id)} className="space-y-3">
            <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
              <div><Label htmlFor="pa-name">Name</Label><Input id="pa-name" name="name" placeholder="Research meeting" required /></div>
              <div><Label htmlFor="pa-day">Weekday</Label><Select id="pa-day" name="dayOfWeek" className="w-32">{DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></div>
              <div><Label htmlFor="pa-start">Starts</Label><Input id="pa-start" name="startTime" type="time" required className="w-28" /></div>
              <div><Label htmlFor="pa-hours">Hours</Label><Input id="pa-hours" name="hours" type="number" min={0.25} max={24} step={0.25} required className="w-24" /></div>
            </div>
            <div className="grid items-end gap-3 sm:grid-cols-[auto_auto_1fr]">
              <div><Label htmlFor="pa-from">From</Label><Input id="pa-from" name="from" type="date" defaultValue={ymd(iv.startDate)} className="w-40" /></div>
              <div><Label htmlFor="pa-until">Until</Label><Input id="pa-until" name="until" type="date" defaultValue={ymd(iv.endDate)} className="w-40" /></div>
              <div><Label htmlFor="pa-skip">Dates it does not happen (optional)</Label><Input id="pa-skip" name="skip" placeholder="2027-01-15, 2027-01-22" /></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="blocks" defaultChecked className="size-4" />If a shift overlaps this session, the individual cannot work it</label>
            <Button size="sm" variant="outline">Add personal academic day</Button>
          </form>
        </Section>
      </div>
      <p className="mt-6 text-xs text-muted"><Link href={`/intervals/${iv.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Go to {iv.name}</Link></p>
    </>
  );
}
