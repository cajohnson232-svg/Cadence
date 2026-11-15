// The interval hub: everything that feeds one scheduling period, on one page.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { compileInterval, type Compiled } from "@/lib/compile";
import { allowance, requestDays } from "@/lib/domain";
import { cancelSchedule, discardSchedule, generateSchedule, setIntervalStatus, setRequestsOpen, unpublishSchedule } from "@/app/actions";
import { BUDGETS, runProgress, settleInterval } from "@/lib/engine";
import { fmtDuration, fmtWhen, shiftsToFill, standing } from "@/lib/schedule-view";
import { RunProgress } from "@/components/run-progress";
import { Select } from "@/components/ui/input";
import { Flash } from "@/components/entity-pages";
import { RequestStatusButtons } from "@/components/request-buttons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, Notice, td, th, type Tone } from "@/components/ui/misc";
import { DOW, addDays, cn, dow, fmtDate, fmtRange, fmtShort, hhmm, overlaps, toMinutes, ymd } from "@/lib/util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const TABS = [["coverage", "Coverage"], ["requests", "Requests & vacations"], ["adjustments", "Adjustments"], ["rules", "Compiled rules"], ["schedule", "Schedule"]] as const;
const statusTone: Record<string, Tone> = { DRAFT: "gray", LOCKED: "amber", PUBLISHED: "green", APPROVED: "green", PENDING: "amber", DENIED: "red" };
const engineTone: Record<string, Tone> = { enforced: "green", "stored only": "gray", "needs review": "amber" };
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");
const person = (p: { firstName: string; lastName: string }) => `${p.lastName}, ${p.firstName}`;

export default async function IntervalHub({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!(await db.interval.findFirst({ where: { id, programId: s.programId } }))) notFound();
  await settleInterval(id);                       // if an engine run has finished since the last visit, bring its result in
  const c = await compileInterval(id);
  const active = await db.schedule.findFirst({ where: { intervalId: id, runStatus: { in: ["QUEUED", "RUNNING"] } } });
  const iv = c.interval;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "coverage";
  const n = c.config.n_days;
  const days = Array.from({ length: n }, (_, i) => addDays(iv.startDate, i));
  const here = `/intervals/${id}`;
  const enforced = c.compiledRules.filter((r) => r.engine === "enforced").length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/intervals" className="text-sm text-brand hover:underline">← All intervals</Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
            {iv.name} <Badge tone={statusTone[iv.status]}>{title(iv.status)}</Badge>
            {iv.requestsOpen ? <Badge tone="green">Requests open</Badge> : <Badge>Requests closed</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {fmtRange(iv.startDate, iv.endDate)} · {n} days · {c.config.residents.length} participants
            {iv.requestDeadline ? ` · request deadline ${fmtDate(iv.requestDeadline)} ${iv.requestDeadline.toISOString().slice(11, 16)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={setRequestsOpen.bind(null, id, !iv.requestsOpen)}><Button variant="outline" size="sm">{iv.requestsOpen ? "Close requests" : "Open requests"}</Button></form>
          {iv.status === "DRAFT" && <form action={setIntervalStatus.bind(null, id, "LOCKED")}><Button variant="outline" size="sm">Lock inputs</Button></form>}
          {iv.status === "LOCKED" && <form action={setIntervalStatus.bind(null, id, "DRAFT")}><Button variant="outline" size="sm">Unlock</Button></form>}
          {iv.status === "PUBLISHED" && <form action={unpublishSchedule.bind(null, id, here)}><Button variant="outline" size="sm">Unpublish</Button></form>}
          <Link href={`${here}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit details</Link>
          {active
            ? <Link href={`${here}?tab=schedule`} className={buttonVariants({ variant: "outline", size: "sm" })}>Generating…</Link>
            : <Link href={`${here}?tab=schedule#generate`} className={buttonVariants({ size: "sm" })}>Generate schedule</Link>}
        </div>
      </div>
      <Flash sp={sp} />
      {iv.status === "LOCKED" && <Notice tone="amber">This interval is locked. Its inputs are meant to stay as they are; unlock it to make changes.</Notice>}
      {iv.status === "PUBLISHED" && <Notice tone="amber">This interval is published. Changing its inputs does not change the published schedule: generate again and publish the new one.</Notice>}
      <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
        {TABS.map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={tab === k} href={`${here}?tab=${k}`}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === k ? "border-brand font-medium text-brand-dark" : "border-transparent text-muted hover:text-ink")}>
            {label}{k === "rules" ? ` (${c.compiledRules.length})` : ""}
          </Link>
        ))}
      </div>
      {tab === "coverage" && <Coverage c={c} days={days} />}
      {tab === "requests" && <Requests c={c} id={id} programId={s.programId} />}
      {tab === "adjustments" && <Adjustments c={c} id={id} />}
      {tab === "rules" && <Rules c={c} id={id} engine={sp.engine} enforced={enforced} />}
      {tab === "schedule" && <ScheduleTab c={c} id={id} enforced={enforced} />}
    </>
  );
}

type C = Awaited<ReturnType<typeof compileInterval>>;

// ───────────────────────────── Coverage: shifts x days with headcount ─────────────────────────────
function Coverage({ c, days }: { c: C; days: Date[] }) {
  const all = c.config.shift_templates as Any[];
  const base = all.filter((t) => !t.only_days).sort((a, b) => a.site.localeCompare(b.site) || toMinutes(a.start) - toMinutes(b.start) || a.name.localeCompare(b.name));
  const dated = all.filter((t) => t.only_days);
  const extra = dated.filter((t) => !base.some((b) => b.ref === t.ref));
  const rows = [...base.map((t) => ({ key: t.ref, t })), ...extra.map((t) => ({ key: t.special_ref, t }))];
  const range = (t: Any) => (t.max_headcount > t.headcount ? `${t.headcount}–${t.max_headcount}` : String(t.headcount));
  const time = (t: Any) => { const st = toMinutes(t.start); return `${t.start}–${hhmm(st + t.hours * 60)}`; };
  const cell = (row: { key: string; t: Any }, d: number, wd: number) => {
    const normal = !row.t.only_days && row.t.weekdays.includes(wd) && !row.t.except_days.includes(d) ? row.t : null;
    const special = dated.filter((t) => t.only_days.includes(d) && (row.t.only_days ? t.special_ref === row.key : t.ref === row.key));
    return { normal, special, need: (normal?.headcount ?? 0) + special.reduce((a, t) => a + t.headcount, 0) };
  };
  const sessions = c.sessions.filter((x) => x.date >= c.interval.startDate);
  const total = days.map((_, d) => rows.reduce((a, r) => a + cell(r, d, dow(days[d])).need, 0));
  const present = days.map((_, d) => (c.config.residents as Any[]).filter((r) => !r.vacation.includes(d) && !r.mandatory_off.includes(d)).length);
  const specialDays = new Map<number, string[]>();
  for (const r of c.compiledRules) if (r.origin === "Special staffing day" && r.from) {
    const d = Math.round((new Date(r.from + "T00:00:00Z").getTime() - c.interval.startDate.getTime()) / 86400000);
    specialDays.set(d, [...(specialDays.get(d) ?? []), `${r.appliesTo}: ${r.text}`]);
  }
  const head = "border-b border-line px-1 py-1 text-center text-[11px] font-medium leading-tight";
  let site = "";
  return (
    <>
      <p className="mb-2 text-sm text-muted">
        Required headcount for every shift on every day, with special staffing days and academic time applied.
        <span className="ml-2 inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-amber-200" /> changed by a special staffing day</span>
        <span className="ml-2 inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-sky-200" /> academic time that day</span>
      </p>
      <Card className="overflow-x-auto">
        <table className="border-collapse text-sm" data-testid="coverage-grid">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-56 border-b border-line bg-white px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">Shift</th>
              {days.map((d, i) => {
                const ses = sessions.filter((x) => ymd(x.date) === ymd(d));
                const sd = specialDays.get(i);
                const tip = [...ses.map((x) => `${x.name} ${hhmm(x.startMinute)}–${hhmm(x.startMinute + x.durationMinutes)} (${x.policy.toLowerCase()})`), ...(sd ?? [])].join("\n");
                return (
                  <th key={i} title={tip || undefined} className={cn(head, "min-w-8", dow(d) >= 5 && "bg-slate-100", ses.length && "bg-sky-100", sd && "bg-amber-100")}>
                    {DOW[dow(d)].slice(0, 2)}<br />{d.getUTCDate()}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((r) => {
              const showSite = r.t.site !== site;
              site = r.t.site;
              return [
                ...(showSite ? [<tr key={"site" + r.t.site}><td colSpan={days.length + 1} className="sticky left-0 border-b border-line bg-surface px-3 py-1 text-xs font-semibold text-muted">{r.t.site}</td></tr>] : []),
                <tr key={r.key}>
                  <th scope="row" className="sticky left-0 z-10 border-b border-line bg-white px-3 py-1 text-left font-normal">
                    <span className="font-medium">{r.t.name}</span> <span className="text-xs text-muted">{time(r.t)} · {r.t.category}{r.t.pod ? ` · ${r.t.pod}` : ""}</span>
                  </th>
                  {days.map((d, i) => {
                    const x = cell(r, i, dow(d));
                    const tip = x.special.map((t) => `${t.name} ${time(t)}, needs ${range(t)}`).join("\n");
                    return (
                      <td key={i} title={tip || undefined} className={cn("border-b border-l border-line px-1 py-1 text-center tabular-nums", dow(d) >= 5 && "bg-slate-50", x.special.length && "bg-amber-100 font-medium", !x.need && "text-slate-300")}>
                        {x.special.length ? x.special.map(range).join("+") + (x.normal ? `+${range(x.normal)}` : "") : x.normal ? range(x.normal) : "·"}
                      </td>
                    );
                  })}
                </tr>,
              ];
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1 text-left text-xs font-semibold">Shifts to fill</th>
              {total.map((t, i) => <td key={i} className="border-l border-line px-1 py-1 text-center text-xs font-semibold tabular-nums">{t}</td>)}
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1 text-left text-xs font-normal text-muted">People not on leave</th>
              {present.map((p, i) => <td key={i} className={cn("border-l border-line px-1 py-1 text-center text-xs tabular-nums", p < total[i] ? "bg-red-100 font-semibold text-red-800" : "text-muted")}>{p}</td>)}
            </tr>
          </tfoot>
        </table>
      </Card>
      <p className="mt-2 text-xs text-muted">
        {total.reduce((a, b) => a + b, 0)} shifts to fill in all. Contracts allow {(c.config.residents as Any[]).reduce((a, r) => a + r.shifts_min, 0)}–{(c.config.residents as Any[]).reduce((a, r) => a + r.shifts_max, 0)}.
        A day turns red when it needs more people than are present and not on leave.
      </p>
    </>
  );
}

// ───────────────────────────── Requests & vacations, per participant ─────────────────────────────
async function Requests({ c, id, programId }: { c: C; id: string; programId: string }) {
  const iv = c.interval;
  const [a, off, people] = await Promise.all([
    allowance(id),
    db.timeOff.findMany({ where: { programId, OR: [{ intervalId: id }, { kind: "VACATION", startDate: { lte: iv.endDate }, endDate: { gte: iv.startDate } }] }, orderBy: { startDate: "asc" } }),
    db.participant.findMany({ where: { programId, id: { in: (c.config.residents as Any[]).map((r) => r.id) } }, include: { role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
  ]);
  const back = `/intervals/${id}?tab=requests`;
  const pending = off.filter((t) => t.status === "PENDING").length;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted">Allowance: {a.days} request day(s) per participant, of which {a.high} high priority. Counted per day requested.</span>
        {pending > 0 && <Badge tone="amber">{pending} waiting for a decision</Badge>}
        <span className="ml-auto flex gap-2">
          <Link href={`/requests/new?intervalId=${id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>New request off</Link>
          <Link href="/vacation/new" className={buttonVariants({ variant: "outline", size: "sm" })}>New vacation</Link>
        </span>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="requests-table">
          <thead className="border-b border-line bg-surface"><tr>{["Participant", "Vacation", "Requests off", "Allowance used"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {people.map((p) => {
              const mine = off.filter((t) => t.participantId === p.id);
              const vac = mine.filter((t) => t.kind === "VACATION");
              const req = mine.filter((t) => t.kind !== "VACATION");
              const counted = req.filter((t) => t.kind === "REQUEST_OFF" && t.status !== "DENIED");
              const used = counted.reduce((x, t) => x + requestDays(t), 0);
              const high = counted.filter((t) => t.priority === "HIGH").reduce((x, t) => x + requestDays(t), 0);
              const over = used > a.days || high > a.high;
              return (
                <tr key={p.id}>
                  <td className={td}><span className="font-medium">{person(p)}</span><div className="text-xs text-muted">{p.role.name}</div></td>
                  <td className={td}>
                    {vac.length ? vac.map((t) => (
                      <div key={t.id} className="flex items-center gap-1.5">
                        <Link href={`/vacation/${t.id}`} className="text-brand hover:underline">{fmtRange(t.startDate, t.endDate)}</Link>
                        {t.status !== "APPROVED" && <Badge tone={statusTone[t.status]}>{title(t.status)}</Badge>}
                      </div>
                    )) : <span className="text-muted">—</span>}
                  </td>
                  <td className={td}>
                    {req.length ? req.map((t) => (
                      <div key={t.id} className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Link href={`/requests/${t.id}`} className="text-brand hover:underline">{t.kind === "REQUEST_OFF" ? fmtRange(t.startDate, t.endDate) : `${title(t.kind)} (${fmtShort(t.startDate)})`}</Link>
                        {t.mandatory ? <Badge tone="red">Mandatory</Badge> : <Badge tone={t.priority === "HIGH" ? "amber" : "gray"}>{title(t.priority ?? "")}</Badge>}
                        <Badge tone={statusTone[t.status]}>{title(t.status)}</Badge>
                        <RequestStatusButtons id={t.id} status={t.status} returnTo={back} />
                        {t.reason && <span className="text-xs text-muted">{t.reason}</span>}
                      </div>
                    )) : <span className="text-muted">—</span>}
                  </td>
                  <td className={cn(td, "whitespace-nowrap tabular-nums", over && "font-semibold text-red-700")}>{used} of {a.days} days · {high} of {a.high} high{over ? " (over)" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ───────────────────────────── Adjustments and the contracts they produce ─────────────────────────────
async function Adjustments({ c, id }: { c: C; id: string }) {
  const adj = await db.shiftAdjustment.findMany({ where: { intervalId: id }, include: { participant: true }, orderBy: { createdAt: "asc" } });
  const asg = await db.assignment.findMany({ where: { programId: c.interval.programId }, include: { institutions: { include: { institution: true } } } });
  return (
    <>
      <div className="mb-3 flex items-center gap-3 text-sm">
        <span className="text-muted">Each participant&apos;s shift count for this interval: their assignment, plus or minus any adjustments.</span>
        <Link href={`/adjustments/new?intervalId=${id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}>New adjustment</Link>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="adjustments-table">
          <thead className="border-b border-line bg-surface"><tr>{["Participant", "Assignment", "Adjustments", "Shifts this interval"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {(c.config.residents as Any[]).map((r) => {
              const mine = adj.filter((x) => x.participantId === r.id);
              const a = asg.filter((x) => x.participantId === r.id && overlaps(x.startDate, x.endDate, c.interval.startDate, c.interval.endDate));
              return (
                <tr key={r.id}>
                  <td className={td}><span className="font-medium">{r.name}</span></td>
                  <td className={td}>{a.map((x) => (
                    <div key={x.id}><Link href={`/assignments/${x.id}`} className="text-brand hover:underline">{fmtRange(x.startDate, x.endDate)}</Link>
                      <span className="text-muted"> · {x.minShifts === x.maxShifts ? x.minShifts : `${x.minShifts}–${x.maxShifts}`} shifts · {x.institutions.map((i) => i.institution.shortCode).join(", ")}</span></div>
                  ))}</td>
                  <td className={td}>{mine.length ? mine.map((x) => (
                    <div key={x.id}><Link href={`/adjustments/${x.id}`} className="text-brand hover:underline">{x.delta > 0 ? "+" : ""}{x.delta}</Link> <span className="text-muted">{x.reason}</span></div>
                  )) : <span className="text-muted">—</span>}</td>
                  <td className={cn(td, "font-medium tabular-nums")}>{r.shifts_min === r.shifts_max ? r.shifts_min : `${r.shifts_min}–${r.shifts_max}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ───────────────────────────── Compiled rules: the one uniform list the engine sees ─────────────────────────────
function Rules({ c, id, engine, enforced }: { c: C; id: string; engine?: string; enforced: number }) {
  const groups = ["enforced", "stored only", "needs review", "not included"];
  const kind = (r: Compiled) => (r.engine.startsWith("not included") ? "not included" : r.engine);
  const rows = c.compiledRules.filter((r) => !engine || kind(r) === engine);
  return (
    <>
      {c.warnings.length > 0 && (
        <Notice tone="amber">
          <div className="font-medium">Before running the engine</div>
          <ul className="mt-1 list-disc pl-5">{c.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Read-only. Every rule, contract, vacation, request and academic series that applies to this interval, as one list. {enforced} of {c.compiledRules.length} are enforced by the engine.</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Link href={`/intervals/${id}?tab=rules`} className={cn("rounded px-2 py-0.5 text-xs", !engine ? "bg-brand text-white" : "border border-line bg-white")}>All</Link>
          {groups.map((g) => (
            <Link key={g} href={`/intervals/${id}?tab=rules&engine=${encodeURIComponent(g)}`} className={cn("rounded px-2 py-0.5 text-xs", engine === g ? "bg-brand text-white" : "border border-line bg-white")}>
              {title(g)} ({c.compiledRules.filter((r) => kind(r) === g).length})
            </Link>
          ))}
          <a href={`/intervals/${id}/engine-input`} className={buttonVariants({ variant: "outline", size: "sm" })}>Download engine input</a>
        </span>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="compiled-rules">
          <thead className="border-b border-line bg-surface"><tr>{["From", "Applies to", "Rule", "Level", "Dates", "Engine"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={r.origin + r.id + i}>
                <td className={cn(td, "whitespace-nowrap")}>{r.origin}{r.source === "AI_ASSISTED" && <Badge tone="blue" className="ml-1">AI-assisted</Badge>}{r.source === "SYSTEM" && <Badge className="ml-1">System</Badge>}</td>
                <td className={td}>{r.appliesTo}</td>
                <td className={td}>{r.text}{r.note && <div className="text-xs text-muted">{r.note}</div>}</td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {r.level === "HARD" ? <Badge tone="red">Hard</Badge> : r.level === "SOFT" ? <Badge tone="blue">Soft</Badge> : "—"}
                  {r.level === "SOFT" && <span className="ml-1 text-xs text-muted">priority {r.priority ?? "—"} · weight {r.weight ?? "—"}</span>}
                </td>
                <td className={cn(td, "whitespace-nowrap text-xs text-muted")}>{r.from || r.to ? `${r.from ?? "…"} to ${r.to ?? "…"}` : "Always"}</td>
                <td className={td}><Badge tone={engineTone[r.engine] ?? "amber"}>{title(r.engine)}</Badge></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted">Nothing in this group.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ───────────────────────────── Schedule: generate, follow the run, list the results ─────────────────────────────
async function ScheduleTab({ c, id, enforced }: { c: C; id: string; enforced: number }) {
  const iv = c.interval, here = `/intervals/${id}`;
  const [program, schedules, openRows] = await Promise.all([
    db.program.findUniqueOrThrow({ where: { id: iv.programId } }),
    db.schedule.findMany({ where: { intervalId: id }, include: { createdBy: true, _count: { select: { shifts: true } } }, orderBy: { createdAt: "desc" } }),
    db.scheduledShift.groupBy({ by: ["scheduleId"], where: { schedule: { intervalId: id }, participantId: null }, _count: true }),
  ]);
  const open = new Map(openRows.map((r) => [r.scheduleId, r._count]));
  const active = schedules.find((x) => x.runStatus === "RUNNING" || x.runStatus === "QUEUED");
  const need = shiftsToFill(c.config, iv.startDate), people = (c.config.residents as Any[]).length;
  const tz = program.timezone;
  return (
    <>
      {active ? (
        <Card className="mb-5 p-4" data-testid="run-card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Generating {active.label}</h2>
            <form action={cancelSchedule.bind(null, active.id)}><Button variant="outline" size="sm">Cancel run</Button></form>
          </div>
          <RunProgress statusUrl={`${here}/schedules/${active.id}/status`} reviewUrl={`${here}/schedules/${active.id}`} initial={runProgress(active)} />
        </Card>
      ) : (
        <Card className="mb-5 p-4" id="generate" data-testid="generate-card">
          <h2 className="text-base font-semibold">Generate a schedule</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The engine fills {need} shifts over {c.config.n_days} days for {people} participant{people === 1 ? "" : "s"}, using the {enforced} entries marked
            {" "}<Link href={`${here}?tab=rules&engine=enforced`} className="text-brand hover:underline">enforced</Link> under Compiled rules. The result is a draft:
            nothing is shown to participants until you review it and publish.
          </p>
          {c.warnings.length > 0 && (
            <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="generate-warnings">
              <p className="font-medium">Before you run</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{c.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {!need || !people ? (
            <Notice tone="red">{!people ? "Nobody is assigned to this interval yet. Add assignments first." : "There are no shifts to fill. Add shifts first."}</Notice>
          ) : (
            <form action={generateSchedule.bind(null, id)} className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Time to spend</span>
                <Select name="budget" defaultValue="standard" className="w-64">
                  {Object.entries(BUDGETS).map(([k, b]) => <option key={k} value={k}>{b.label} ({b.hint})</option>)}
                </Select>
              </label>
              <Button>Generate schedule</Button>
              <p className="basis-full text-xs text-muted">Every hard rule holds whichever you choose. More time improves the lower-priority goals, such as days off kept together and requests off.</p>
            </form>
          )}
        </Card>
      )}

      <h2 className="mb-2 text-base font-semibold">Schedules for this interval</h2>
      <Card className="overflow-x-auto">
        <table className="w-full" data-testid="schedules-table">
          <thead className="border-b border-line bg-surface"><tr>{["Schedule", "Made", "Status", "Shifts", "Rule check", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {schedules.map((x) => {
              const st = standing(x), rep = x.report as Any, done = x.runStatus === "DONE";
              const o = open.get(x.id) ?? 0, v = rep?.validator?.hard_violations?.length;
              return (
                <tr key={x.id}>
                  <td className={td}>
                    {done ? <Link href={`${here}/schedules/${x.id}`} className="font-medium text-brand hover:underline">{x.label ?? "Schedule"}</Link> : <span className="font-medium">{x.label ?? "Schedule"}</span>}
                    <div className="text-xs text-muted">{x.source === "SOLVER" ? "Generated by the engine" : x.source === "IMPORT" ? "Imported" : "Entered by hand"}</div>
                  </td>
                  <td className={td}>{fmtWhen(x.createdAt, tz)}<div className="text-xs text-muted">{x.createdBy?.name ?? ""}{done && rep?.engine?.seconds ? ` · took ${fmtDuration(rep.engine.seconds)}` : ""}</div></td>
                  <td className={td}><Badge tone={st.tone}>{st.text}</Badge>{x.error && <div className="mt-1 max-w-md text-xs text-red-700">{x.error}</div>}</td>
                  <td className={td}>{done ? <>{x._count.shifts - o} of {x._count.shifts} filled{o > 0 && <Badge tone="red" className="ml-2">{o} open</Badge>}</> : "–"}</td>
                  <td className={td}>{!done || v === undefined ? "–" : v === 0 ? <span className="text-emerald-700">No hard rule broken</span> : <Badge tone="red">{v} broken</Badge>}</td>
                  <td className={cn(td, "whitespace-nowrap text-right")}>
                    <span className="inline-flex items-center gap-2">
                      {done && <Link href={`${here}/schedules/${x.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Review</Link>}
                      {x.status !== "PUBLISHED" && x.runStatus !== "RUNNING" && x.runStatus !== "QUEUED" &&
                        <form action={discardSchedule.bind(null, x.id)}><button className="text-xs text-red-700 hover:underline">Discard</button></form>}
                    </span>
                  </td>
                </tr>
              );
            })}
            {!schedules.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted">No schedule yet. Generate one above.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
