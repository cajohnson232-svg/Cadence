// The resident's own page (a first version): what the schedule will be built from for them,
// their requests off against the allowance, and their calendar feed.
import Link from "next/link";
import { requireSession, siteOrigin } from "@/lib/auth";
import { db } from "@/lib/db";
import { academicSessions, attends, requestDays, sessionLabel } from "@/lib/domain";
import { signOut, submitMyRequest, withdrawMyRequest } from "@/app/actions";
import { Flash } from "@/components/entity-pages";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge, Card, Notice, td, th, type Tone } from "@/components/ui/misc";
import { addDays, fmtDate, fmtRange, overlaps, shiftTimes, ymd } from "@/lib/util";

const tone: Record<string, Tone> = { APPROVED: "green", PENDING: "amber", DENIED: "red" };
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export default async function Me({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const origin = await siteOrigin();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const me = s.participantId ? await db.participant.findUnique({ where: { id: s.participantId }, include: { role: true, program: true } }) : null;
  const shell = (body: React.ReactNode) => (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <header className="mb-6 flex items-center justify-between border-b border-line pb-4">
        <div><div className="text-lg font-semibold tracking-tight text-brand-dark">Cadence</div><div className="text-xs text-muted">{s.programName}</div></div>
        <div className="flex items-center gap-4 text-sm">
          {s.access !== "RESIDENT" && <Link href="/intervals" className="text-brand hover:underline">Admin screens</Link>}
          <span className="text-muted">{s.userName}</span>
          <Link href="/account" className="text-brand hover:underline">Your account</Link>
          <form action={signOut}><button className="text-brand hover:underline">Sign out</button></form>
        </div>
      </header>
      <Flash sp={sp} />
      {body}
    </div>
  );
  if (!me) return shell(<Notice tone="amber">This sign-in is not linked to a participant, so there is no personal schedule to show.</Notice>);

  const [assignments, timeOff, intervals, upcoming] = await Promise.all([
    db.assignment.findMany({ where: { participantId: me.id, endDate: { gte: addDays(today, -31) } }, include: { institutions: { include: { institution: true } }, shifts: { include: { shift: true } } }, orderBy: { startDate: "asc" } }),
    db.timeOff.findMany({ where: { participantId: me.id, endDate: { gte: addDays(today, -31) } }, include: { interval: true }, orderBy: { startDate: "asc" } }),
    db.interval.findMany({ where: { programId: me.programId, endDate: { gte: today } }, orderBy: { startDate: "asc" } }),
    db.scheduledShift.findMany({ where: { participantId: me.id, schedule: { status: "PUBLISHED" }, endsAt: { gte: today } }, include: { institution: true }, orderBy: { startsAt: "asc" }, take: 40 }),
  ]);
  const mineIv = intervals.filter((i) => assignments.some((a) => overlaps(a.startDate, a.endDate, i.startDate, i.endDate)));
  const open = mineIv.filter((i) => i.requestsOpen && i.status === "DRAFT" && (!i.requestDeadline || new Date() <= i.requestDeadline));
  const sessions = mineIv.length ? (await academicSessions(me.programId, mineIv[0].startDate, mineIv[mineIv.length - 1].endDate)).filter((x) => attends(x, me) && x.date >= today).slice(0, 8) : [];
  const usage = (ivId: string) => {
    const r = timeOff.filter((t) => t.intervalId === ivId && t.kind === "REQUEST_OFF" && t.status !== "DENIED");
    return { days: r.reduce((n, t) => n + requestDays(t), 0), high: r.filter((t) => t.priority === "HIGH").reduce((n, t) => n + requestDays(t), 0) };
  };
  return shell(
    <>
      <h1 className="text-xl font-semibold tracking-tight">{me.firstName} {me.lastName} <span className="text-base font-normal text-muted">· {me.role.name}</span></h1>
      <p className="mt-1 text-sm text-muted">What your schedule is built from. You can submit requests off here; everything else is set by your chiefs and coordinator.</p>

      <section className="mt-6">
        <h2 className="text-base font-semibold">Requests off</h2>
        {mineIv.map((iv) => {
          const u = usage(iv.id);
          const allow = iv.requestAllowance ?? me.program.defaultRequestAllowance, high = iv.highPriorityAllowance ?? me.program.defaultHighPriorityAllowance;
          const mine = timeOff.filter((t) => t.intervalId === iv.id && t.kind !== "VACATION");
          const isOpen = open.some((o) => o.id === iv.id);
          return (
            <Card key={iv.id} className="mt-2 overflow-hidden" data-testid={`requests-${iv.name}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 text-sm">
                <span className="font-medium">{iv.name}</span><span className="text-muted">{fmtRange(iv.startDate, iv.endDate)}</span>
                {isOpen ? <Badge tone="green">Open{iv.requestDeadline ? ` until ${fmtDate(iv.requestDeadline)}` : ""}</Badge> : <Badge>{iv.status !== "DRAFT" ? title(iv.status) : !iv.requestsOpen ? "Closed" : "Deadline passed"}</Badge>}
                <span className="ml-auto tabular-nums text-muted">Used {u.days} of {allow} days · {u.high} of {high} high priority</span>
              </div>
              <table className="w-full">
                <tbody className="divide-y divide-line">
                  {mine.map((t) => (
                    <tr key={t.id}>
                      <td className={td}>{t.kind === "REQUEST_OFF" ? fmtRange(t.startDate, t.endDate) : `${title(t.kind)} (${fmtDate(t.startDate)})`}{requestDays(t) > 1 ? ` · ${requestDays(t)} days` : ""}</td>
                      <td className={td}>{t.mandatory ? <Badge tone="red">Mandatory</Badge> : <Badge tone={t.priority === "HIGH" ? "amber" : "gray"}>{title(t.priority ?? "")}</Badge>}</td>
                      <td className={td}><Badge tone={tone[t.status]}>{title(t.status)}</Badge></td>
                      <td className={td}>{t.reason}</td>
                      <td className={td}>{t.kind === "REQUEST_OFF" && iv.status === "DRAFT" && t.createdById === s.userId && <form action={withdrawMyRequest.bind(null, t.id)}><button className="text-xs text-red-700 hover:underline">Withdraw</button></form>}</td>
                    </tr>
                  ))}
                  {!mine.length && <tr><td className="px-3 py-3 text-sm text-muted">No requests for this interval.</td></tr>}
                </tbody>
              </table>
            </Card>
          );
        })}
        {!mineIv.length && <p className="mt-2 text-sm text-muted">You have no assignment in a current or upcoming interval.</p>}
        {open.length > 0 && (
          <Card className="mt-3 p-4">
            <form action={submitMyRequest} className="flex flex-wrap items-end gap-3">
              <div><Label htmlFor="intervalId">Interval</Label><Select id="intervalId" name="intervalId" className="w-auto">{open.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></div>
              <div><Label htmlFor="startDate">First day</Label><Input id="startDate" name="startDate" type="date" min={ymd(open[0].startDate)} max={ymd(open[open.length - 1].endDate)} required /></div>
              <div><Label htmlFor="endDate">Last day (optional)</Label><Input id="endDate" name="endDate" type="date" min={ymd(open[0].startDate)} max={ymd(open[open.length - 1].endDate)} /></div>
              <div><Label htmlFor="priority">Priority</Label><Select id="priority" name="priority" defaultValue="MEDIUM" className="w-auto"><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></Select></div>
              <div className="min-w-48 flex-1"><Label htmlFor="reason">Reason (optional)</Label><Input id="reason" name="reason" /></div>
              <Button>Submit request</Button>
            </form>
            <p className="mt-2 text-xs text-muted">Each day you ask for counts against the allowance. {me.program.requestsRequireApproval ? "Requests count once a chief or coordinator approves them." : "Requests count as soon as you submit them."}</p>
          </Card>
        )}
      </section>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="text-base font-semibold">Assignments</h2>
          <Card className="mt-2 divide-y divide-line">
            {assignments.map((a) => (
              <div key={a.id} className="px-3 py-2 text-sm">
                <div className="font-medium">{fmtRange(a.startDate, a.endDate)}</div>
                <div className="text-muted">{a.minShifts === a.maxShifts ? a.minShifts : `${a.minShifts}–${a.maxShifts}`} shifts · {a.institutions.map((i) => i.institution.name).join(", ")}</div>
                {a.shifts.length > 0 && <div className="text-xs text-muted">Only: {a.shifts.map((x) => x.shift.name).join(", ")}</div>}
              </div>
            ))}
            {!assignments.length && <div className="px-3 py-3 text-sm text-muted">None.</div>}
          </Card>
        </section>
        <section>
          <h2 className="text-base font-semibold">Vacation</h2>
          <Card className="mt-2 divide-y divide-line">
            {timeOff.filter((t) => t.kind === "VACATION").map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm"><span>{fmtRange(t.startDate, t.endDate)}</span><Badge tone={tone[t.status]}>{title(t.status)}</Badge><span className="text-muted">{t.reason}</span></div>
            ))}
            {!timeOff.some((t) => t.kind === "VACATION") && <div className="px-3 py-3 text-sm text-muted">None on record.</div>}
          </Card>
          <h2 className="mt-5 text-base font-semibold">Academic time</h2>
          <Card className="mt-2 divide-y divide-line">
            {sessions.map((x, i) => <div key={i} className="px-3 py-2 text-sm">{sessionLabel(x)}</div>)}
            {!sessions.length && <div className="px-3 py-3 text-sm text-muted">Nothing coming up.</div>}
          </Card>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="text-base font-semibold">Published shifts</h2>
        <Card className="mt-2 overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-line bg-surface"><tr>{["Date", "Shift", "Time", "Where"].map((x) => <th key={x} className={th}>{x}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {upcoming.map((x) => (
                <tr key={x.id}><td className={td}>{fmtDate(new Date(ymd(x.startsAt) + "T00:00:00Z"))}</td><td className={td}>{x.name}</td>
                  <td className={td}>{shiftTimes(x.startsAt.getUTCHours() * 60 + x.startsAt.getUTCMinutes(), Math.round((x.endsAt.getTime() - x.startsAt.getTime()) / 60000))}</td><td className={td}>{x.institution.name}</td></tr>
              ))}
              {!upcoming.length && <tr><td colSpan={4} className="px-3 py-4 text-sm text-muted">No published shifts coming up yet.</td></tr>}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-sm text-muted">Add your schedule to Google, Apple or Outlook calendar by subscribing to this private link:{" "}
          <code className="break-all rounded bg-white px-1 py-0.5 text-xs" data-testid="feed-url">{origin}/api/calendar/{me.calendarToken}</code></p>
      </section>
    </>,
  );
}
