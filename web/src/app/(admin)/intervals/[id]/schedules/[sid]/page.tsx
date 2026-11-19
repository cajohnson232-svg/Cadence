// Review one schedule: who works what, what is still open, whether every hard rule holds,
// how the goals came out, and the publish / unpublish / discard decisions.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { settleRun } from "@/lib/engine";
import { publishChecks } from "@/lib/schedules";
import { discardSchedule, optimizeSchedule, publishSchedule, unpublishSchedule } from "@/app/actions";
import { BUDGETS } from "@/lib/engine";
import { Select } from "@/components/ui/input";
import { GOALS, categoryColors, fmtDuration, fmtWhen, shortCodes, standing, tint } from "@/lib/schedule-view";
import { Flash } from "@/components/entity-pages";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, Notice, td, th } from "@/components/ui/misc";
import { DOW, addDays, cn, dayDiff, dow, fmtDate, fmtRange, fmtShort, hhmm, ymd } from "@/lib/util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const VIEWS = [["people", "By person"], ["shifts", "By shift"], ["details", "Goals & checks"]] as const;
const minuteOfDay = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const span = (a: Date, b: Date) => `${hhmm(minuteOfDay(a))}–${hhmm(minuteOfDay(b))}`;
const g = (n: number) => +n.toFixed(1);

export default async function ScheduleReview({ params, searchParams }: { params: Promise<{ id: string; sid: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const { id, sid } = await params;
  const sp = await searchParams;
  await settleRun(sid);
  const checks = await publishChecks(sid, s.programId);
  if (!checks || checks.sch.intervalId !== id) notFound();
  const { sch } = checks, iv = sch.interval;
  const hub = `/intervals/${id}`, here = `${hub}/schedules/${sid}`;
  if (sch.runStatus === "RUNNING" || sch.runStatus === "QUEUED") redirect(`${hub}?tab=schedule`);

  const [program, rows, cats, everyone, creator, published] = await Promise.all([
    db.program.findUniqueOrThrow({ where: { id: s.programId } }),
    db.scheduledShift.findMany({ where: { scheduleId: sid, backup: false }, include: { institution: true }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] }),
    db.shiftCategory.findMany({ where: { programId: s.programId } }),
    db.participant.findMany({ where: { programId: s.programId }, include: { role: true } }),
    sch.createdById ? db.user.findUnique({ where: { id: sch.createdById } }) : null,
    db.schedule.findFirst({ where: { intervalId: id, status: "PUBLISHED", id: { not: sid } } }),
  ]);
  const tz = program.timezone, st = standing(sch);
  const backupRows = await db.scheduledShift.findMany({ where: { scheduleId: sid, backup: true }, orderBy: [{ startsAt: "asc" }, { name: "asc" }] });
  const rep = sch.report as Any, snap = sch.inputSnapshot as Any;
  const view = VIEWS.some(([k]) => k === sp.view) ? sp.view! : "people";
  const head = (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link href={`${hub}?tab=schedule`} className="text-sm text-brand hover:underline">← {iv.name}</Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
          {iv.name} · {sch.label ?? "Schedule"} <Badge tone={st.tone} data-testid="schedule-status">{st.text}</Badge>
        </h1>
        <p className="mt-1 text-sm text-muted">
          {fmtRange(iv.startDate, iv.endDate)} · {sch.source === "SOLVER" ? "generated" : sch.source === "IMPORT" ? "imported" : "entered"} {fmtWhen(sch.createdAt, tz)}
          {creator ? ` by ${creator.name}` : ""}{rep?.engine?.seconds ? ` · took ${fmtDuration(rep.engine.seconds)}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sch.runStatus === "DONE" && <a href={`${here}/csv`} className={buttonVariants({ variant: "outline", size: "sm" })}>Download spreadsheet</a>}
        <Link href={`${hub}?tab=schedule#generate`} className={buttonVariants({ variant: "outline", size: "sm" })}>Generate again</Link>
        {sch.status === "PUBLISHED"
          ? <form action={unpublishSchedule.bind(null, id, here)}><Button variant="outline" size="sm">Unpublish</Button></form>
          : <form action={discardSchedule.bind(null, sid)}><Button variant="danger" size="sm">Discard</Button></form>}
      </div>
    </div>
  );

  if (sch.runStatus !== "DONE") {
    return (
      <>
        {head}
        <Flash sp={sp} />
        <Notice tone={sch.runStatus === "FAILED" ? "red" : "amber"}>
          {sch.runStatus === "FAILED" ? sch.error ?? "The engine stopped before it produced a schedule. Nothing was saved." : "This run was cancelled before it finished. Nothing was saved."}
        </Notice>
        {rep?.log && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">Technical details (the engine&apos;s last output)</summary>
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-white p-3 text-xs" data-testid="engine-log">{rep.log}</pre>
          </details>
        )}
      </>
    );
  }

  // ───────── the schedule itself ─────────
  const n = dayDiff(iv.startDate, iv.endDate) + 1;
  const days = Array.from({ length: n }, (_, i) => addDays(iv.startDate, i));
  const dayOf = (d: Date) => dayDiff(iv.startDate, d);
  const calOf = (d: Date) => dayDiff(iv.startDate, new Date(ymd(d) + "T00:00:00Z"));
  const inRange = rows.filter((r) => dayOf(r.dutyDate) >= 0 && dayOf(r.dutyDate) < n);
  const color = categoryColors(cats), catById = new Map(cats.map((c) => [c.id, c]));
  const code = shortCodes(rows.map((r) => r.name));
  const byId = new Map(everyone.map((p) => [p.id, p]));
  const lastNames = new Map<string, number>();
  for (const p of everyone) lastNames.set(p.lastName, (lastNames.get(p.lastName) ?? 0) + 1);
  const short = (pid: string) => { const p = byId.get(pid); return !p ? "?" : (lastNames.get(p.lastName) ?? 0) > 1 ? `${p.lastName} ${p.firstName[0]}.` : p.lastName; };
  const snapPeople = new Map<string, Any>((snap?.residents ?? []).map((r: Any) => [r.id, r]));
  const stats = new Map<string, Any>((rep?.residents ?? []).map((r: Any) => [r.id, r]));
  const ids = [...new Set<string>([...snapPeople.keys(), ...rows.flatMap((r) => (r.participantId ? [r.participantId] : []))])]
    .filter((p) => byId.has(p))
    .sort((a, b) => byId.get(a)!.role.level - byId.get(b)!.role.level || byId.get(a)!.lastName.localeCompare(byId.get(b)!.lastName) || byId.get(a)!.firstName.localeCompare(byId.get(b)!.firstName));
  const academicDays = new Map<number, string[]>();
  for (const a of (snap?.academic_time ?? []) as Any[]) if (a.day >= 0 && a.day < n) academicDays.set(a.day, [...(academicDays.get(a.day) ?? []), `${a.name} ${a.start} (${a.hours}h)`]);

  const total = rows.length, openRows = rows.filter((r) => !r.participantId), filled = total - openRows.length;
  const backupOpen = backupRows.filter((r) => !r.participantId).length;
  const violations: string[] = checks.violations;
  const under: string[] = rep?.validator?.under_contract_minimum ?? [];
  const requested = [...snapPeople.values()].reduce((a, r) => a + Object.keys(r.requests_off ?? {}).length, 0);
  const missed = [...stats.values()].reduce((a, r) => a + (r.requests_off_missed?.length ?? 0), 0);
  const weekLimit = snap?.rules?.max_week_hours;
  const precheck = ((rep?.precheck?.errors ?? []) as string[]).map((v) => v.replace(/\bresidents\b/g, "people"));
  const tile = "rounded-lg border border-line bg-white px-3 py-2";
  const thDay = "border-b border-line px-1 py-1 text-center text-[11px] font-medium leading-tight";

  return (
    <>
      {head}
      <Flash sp={sp} />
      {sch.status === "PUBLISHED" && <Notice tone="green">Published {fmtWhen(sch.publishedAt, tz)}. Participants see these shifts on their own page and in their calendar link.</Notice>}
      {checks.stale && (
        <Notice tone="amber">
          <span data-testid="stale-notice">The inputs for {iv.name} have changed since this schedule was generated (for example a request was approved, or a rule or shift was edited). This schedule does not reflect those changes.</span>{" "}
          <Link href={`${hub}?tab=schedule#generate`} className="font-medium underline">Generate again</Link>
        </Notice>
      )}
      {violations.length > 0 && (
        <Notice tone="red">
          <p className="font-medium">The independent rule check found {violations.length} hard rule{violations.length === 1 ? "" : "s"} broken. This schedule cannot be published.</p>
          <ul className="mt-1 list-disc pl-5">{violations.slice(0, 20).map((v, i) => <li key={i}>{v}</li>)}</ul>
        </Notice>
      )}
      {precheck.length > 0 && (
        <Notice tone="red">
          <p className="font-medium">Before it started, the engine found that these inputs cannot be fully staffed:</p>
          <ul className="mt-1 list-disc pl-5">{precheck.slice(0, 4).map((v, i) => <li key={i}>{v}</li>)}</ul>
          {precheck.length > 4 && (
            <details className="mt-1">
              <summary className="cursor-pointer">and {precheck.length - 4} more</summary>
              <ul className="mt-1 list-disc pl-5">{precheck.slice(4).map((v, i) => <li key={i}>{v}</li>)}</ul>
            </details>
          )}
        </Notice>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="summary">
        <div className={tile}><div className="text-xs text-muted">Shifts filled</div><div className="text-lg font-semibold tabular-nums">{filled} <span className="text-sm font-normal text-muted">of {total}</span></div></div>
        <div className={cn(tile, openRows.length > 0 && "border-red-200 bg-red-50")}><div className="text-xs text-muted">Open shifts</div><div className={cn("text-lg font-semibold tabular-nums", openRows.length > 0 && "text-red-700")} data-testid="open-count">{openRows.length}</div></div>
        <div className={cn(tile, violations.length > 0 && "border-red-200 bg-red-50")}>
          <div className="text-xs text-muted">Hard rules</div>
          <div className={cn("text-lg font-semibold", violations.length ? "text-red-700" : rep ? "text-emerald-700" : "text-muted")} data-testid="rule-check">{!rep ? "Not checked" : violations.length ? `${violations.length} broken` : "None broken"}</div>
        </div>
        <div className={tile}><div className="text-xs text-muted">Below contract minimum</div><div className="text-lg font-semibold tabular-nums">{rep ? under.length : "–"} <span className="text-sm font-normal text-muted">{under.length === 1 ? "person" : "people"}</span></div></div>
        <div className={tile}><div className="text-xs text-muted">Most hours in any 7 days</div><div className="text-lg font-semibold tabular-nums">{rep?.duty ? g(rep.duty.peak_rolling_7day_hours) : "–"}{weekLimit ? <span className="text-sm font-normal text-muted"> of {weekLimit} allowed</span> : null}</div></div>
        {backupRows.length > 0 && (
          <div className={cn(tile, backupOpen > 0 && "border-red-200 bg-red-50")} data-testid="backup-tile"><div className="text-xs text-muted">Backup days covered</div>
            <div className={cn("text-lg font-semibold tabular-nums", backupOpen > 0 && "text-red-700")}>{backupRows.length - backupOpen} <span className="text-sm font-normal text-muted">of {backupRows.length}</span></div></div>
        )}
        <div className={tile}><div className="text-xs text-muted">Request days granted</div><div className="text-lg font-semibold tabular-nums">{rep ? requested - missed : "–"} <span className="text-sm font-normal text-muted">of {requested}</span></div></div>
      </div>

      {sch.status !== "PUBLISHED" && (
        <Card className="mb-5 p-4" data-testid="publish-card">
          <h2 className="text-base font-semibold">Publish this schedule</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Publishing shows these shifts to participants on their own page and in their calendar links, marks {iv.name} as published, and makes this
            schedule&apos;s last week the starting point for the next interval&apos;s rest and duty-hour rules.
            {published ? ` It replaces ${published.label ?? "the schedule"} that is published now.` : ""}
          </p>
          {checks.blocked ? (
            <p className="mt-3 text-sm font-medium text-red-700" data-testid="publish-blocked">{checks.blocked}</p>
          ) : (
            <form action={publishSchedule.bind(null, sid)} className="mt-3 flex flex-wrap items-center gap-4">
              {checks.caveats.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="confirm" className="mt-0.5 size-4 accent-[var(--color-brand)]" />
                  <span>Publish anyway: {checks.caveats.join(", and ")}.</span>
                </label>
              )}
              <Button>Publish schedule</Button>
            </form>
          )}
        </Card>
      )}

      {sch.runStatus === "DONE" && rep && (
        <Card className="mb-5 p-4" data-testid="optimize-card">
          <h2 className="text-base font-semibold">Optimize this schedule</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Keeps working on the goals below, starting from this schedule. Every hard rule still holds, and no goal gets worse unless a goal higher in the list improves.
            The result is saved as a new draft next to this one; this one is not changed.{backupRows.length ? " Backup days are chosen again for the new schedule." : ""}
          </p>
          {checks.stale ? (
            <p className="mt-3 text-sm text-amber-800">The inputs have changed since this schedule was made, so it cannot be optimized. Generate a new schedule instead.</p>
          ) : (
            <form action={optimizeSchedule.bind(null, sid)} className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm"><span className="mb-1 block font-medium">Time to spend</span>
                <Select name="budget" defaultValue="standard" className="w-48">
                  <option value="quick">1 minute</option><option value="standard">5 minutes</option><option value="thorough">15 minutes</option>
                </Select>
              </label>
              <Button variant="outline">Optimize</Button>
            </form>
          )}
        </Card>
      )}

      <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
        {VIEWS.map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={view === k} href={`${here}?view=${k}`}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", view === k ? "border-brand font-medium text-brand-dark" : "border-transparent text-muted hover:text-ink")}>
            {label}{k === "details" && openRows.length > 0 ? ` (${openRows.length} open)` : ""}
          </Link>
        ))}
      </div>

      {view === "people" && (() => {
        const backupBy = new Map<string, Map<number, (typeof backupRows)[number]>>();
        for (const b of backupRows) if (b.participantId) {
          const m = backupBy.get(b.participantId) ?? new Map(); backupBy.set(b.participantId, m); m.set(dayOf(b.dutyDate), b);
        }
        const mine = new Map<string, Map<number, typeof rows>>();
        for (const r of inRange) if (r.participantId) {
          const m = mine.get(r.participantId) ?? new Map(); mine.set(r.participantId, m);
          m.set(dayOf(r.dutyDate), [...(m.get(dayOf(r.dutyDate)) ?? []), r]);
        }
        let role = "";
        return (
          <>
            <Card className="overflow-x-auto">
              <table className="border-collapse text-sm" data-testid="people-grid">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 min-w-36 border-b border-line bg-white px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">Participant</th>
                    <th className={cn(thDay, "px-2")}>Shifts</th>
                    <th className={cn(thDay, "px-1.5")}>Nights</th>
                    {backupRows.length > 0 && <th className={cn(thDay, "px-1.5")} title="Backup (on call) days">Backup</th>}
                    {days.map((d, i) => (
                      <th key={i} title={academicDays.get(i)?.join("\n")} className={cn(thDay, "min-w-[33px]", dow(d) >= 5 && "bg-slate-100", academicDays.has(i) && "bg-sky-100")}>{DOW[dow(d)].slice(0, 2)}<br />{d.getUTCDate()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ids.flatMap((pid) => {
                    const p = byId.get(pid)!, sn = snapPeople.get(pid), stt = stats.get(pid);
                    const count = [...(mine.get(pid)?.values() ?? [])].reduce((a, x) => a + x.length, 0);
                    const nights = [...(mine.get(pid)?.values() ?? [])].flat().filter((r) => catById.get(r.categoryId)?.isNight).length;
                    const outside = sn && (count < sn.shifts_min || count > sn.shifts_max);
                    const header = p.role.name !== role ? [<tr key={"role" + p.role.id}><td colSpan={n + 3 + (backupRows.length ? 1 : 0)} className="sticky left-0 border-b border-line bg-surface px-3 py-1 text-xs font-semibold text-muted">{p.role.name}</td></tr>] : [];
                    role = p.role.name;
                    return [...header,
                      <tr key={pid} data-person={pid}>
                        <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-line bg-white px-3 py-1 text-left font-normal">{p.lastName}, {p.firstName}</th>
                        <td className={cn("whitespace-nowrap border-b border-l border-line px-2 py-1 text-center tabular-nums", outside && "bg-red-50 font-semibold text-red-700")} title={sn ? `Contract: ${sn.shifts_min}–${sn.shifts_max} shifts` : undefined}>
                          {count}{sn ? <span className="text-[11px] text-muted"> /{sn.shifts_min === sn.shifts_max ? sn.shifts_max : `${sn.shifts_min}–${sn.shifts_max}`}</span> : null}
                        </td>
                        <td className="border-b border-l border-line px-2 py-1 text-center tabular-nums">{nights || "·"}</td>
                        {backupRows.length > 0 && <td className="border-b border-l border-line px-2 py-1 text-center tabular-nums">{backupBy.get(pid)?.size || "·"}</td>}
                        {days.map((d, i) => {
                          const x = mine.get(pid)?.get(i) ?? [];
                          const base = cn("border-b border-l border-line px-0 py-1 text-center text-[10.5px] leading-4", dow(d) >= 5 && "bg-slate-50");
                          if (x.length) {
                            const r = x[0], cat = catById.get(r.categoryId);
                            const wanted = sn?.requests_off && String(calOf(r.startsAt)) in sn.requests_off;
                            const tip = `${r.name} · ${r.institution.name}\n${fmtDate(new Date(ymd(r.startsAt) + "T00:00:00Z"))} ${span(r.startsAt, r.endsAt)}` + (wanted ? "\nAsked for this day off (request not granted)" : "");
                            return (
                              <td key={i} title={tip} data-shift={r.name} className={cn(base, "font-semibold", wanted && "outline outline-2 -outline-offset-2 outline-red-500")}
                                style={{ background: tint(color.get(r.categoryId) ?? "#64748b", cat?.isNight ? 32 : 20) }}>
                                {code.get(r.name)}{x.length > 1 ? "+" : ""}
                              </td>
                            );
                          }
                          const bu = backupBy.get(pid)?.get(i);
                          if (bu) return <td key={i} title={`${bu.name} (on call) ${span(bu.startsAt, bu.endsAt)}`} data-backup={bu.name} className={cn(base, "font-semibold text-violet-800")} style={{ background: "repeating-linear-gradient(45deg, #ede9fe, #ede9fe 3px, #f5f3ff 3px, #f5f3ff 6px)" }}>BU</td>;
                          if (sn?.vacation?.includes(i)) return <td key={i} title="Vacation" className={cn(base, "bg-slate-200 text-slate-600")}>VAC</td>;
                          if (sn?.mandatory_off?.includes(i)) return <td key={i} title="Not available (not assigned that day, or a required day off)" className={cn(base, "bg-slate-100 text-slate-400")}>off</td>;
                          if (sn?.requests_off && String(i) in sn.requests_off) return <td key={i} title="Request off: granted" className={cn(base, "text-emerald-700")}>req</td>;
                          return <td key={i} className={base} />;
                        })}
                      </tr>];
                  })}
                </tbody>
              </table>
            </Card>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" data-testid="legend">
              {[...code.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([name, c]) => {
                const r = rows.find((x) => x.name === name)!;
                return <span key={name} className="inline-flex items-center gap-1"><span className="rounded px-1 font-semibold text-ink" style={{ background: tint(color.get(r.categoryId) ?? "#64748b", catById.get(r.categoryId)?.isNight ? 32 : 20) }}>{c}</span>{name} {span(r.startsAt, r.endsAt)}</span>;
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              A night that starts after midnight is shown on the day it belongs to (the evening before). VAC = vacation · off = not available that day · req = a request off that was granted ·
              a red outline = working on a day they asked to have off · blue column = academic time that day{backupRows.length ? " · BU = on backup (on call; not a worked shift)" : ""}. Hover a cell for the details.
            </p>
          </>
        );
      })()}

      {view === "shifts" && (() => {
        const lines = new Map<string, { name: string; inst: string; start: number; dur: number; cat: string; cells: Map<number, typeof rows> }>();
        for (const r of inRange) {
          const start = minuteOfDay(r.startsAt), dur = Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60000);
          const key = `${r.institution.name}|${String(start).padStart(4, "0")}|${r.name}|${dur}`;
          const line = lines.get(key) ?? { name: r.name, inst: r.institution.name, start, dur, cat: r.categoryId, cells: new Map() };
          lines.set(key, line);
          line.cells.set(dayOf(r.dutyDate), [...(line.cells.get(dayOf(r.dutyDate)) ?? []), r]);
        }
        let inst = "";
        return (
          <Card className="overflow-x-auto">
            <table className="border-collapse text-sm" data-testid="shift-grid">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-52 border-b border-line bg-white px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">Shift</th>
                  {days.map((d, i) => <th key={i} className={cn(thDay, "min-w-20", dow(d) >= 5 && "bg-slate-100", academicDays.has(i) && "bg-sky-100")}>{DOW[dow(d)]} {d.getUTCDate()}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...lines.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([key, l]) => {
                  const header = l.inst !== inst ? [<tr key={"inst" + l.inst}><td colSpan={n + 1} className="sticky left-0 border-b border-line bg-surface px-3 py-1 text-xs font-semibold text-muted">{l.inst}</td></tr>] : [];
                  inst = l.inst;
                  return [...header,
                    <tr key={key}>
                      <th scope="row" className="sticky left-0 z-10 border-b border-line bg-white px-3 py-1 text-left font-normal" style={{ boxShadow: `inset 3px 0 0 ${color.get(l.cat) ?? "#64748b"}` }}>
                        <span className="font-medium">{l.name}</span> <span className="whitespace-nowrap text-xs text-muted">{hhmm(l.start)}–{hhmm(l.start + l.dur)}</span>
                      </th>
                      {days.map((d, i) => {
                        const x = l.cells.get(i) ?? [];
                        return (
                          <td key={i} className={cn("border-b border-l border-line px-1 py-1 text-center text-xs", dow(d) >= 5 && "bg-slate-50", x.some((r) => !r.participantId) && "bg-red-50")}>
                            {x.length ? x.map((r, j) => r.participantId
                              ? <div key={j} className="whitespace-nowrap">{short(r.participantId)}</div>
                              : <div key={j} className="font-semibold text-red-700">Open</div>) : <span className="text-slate-300">·</span>}
                          </td>
                        );
                      })}
                    </tr>];
                })}
              </tbody>
            </table>
          </Card>
        );
      })()}

      {view === "details" && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-base font-semibold">Open shifts</h2>
            {openRows.length === 0 ? <p className="text-sm text-muted">None. Every shift has the people it needs.</p> : (
              <Card className="divide-y divide-line" data-testid="open-list">
                {((rep?.open ?? []) as Any[]).map((o, i) => (
                  <div key={i} className="px-3 py-2 text-sm">
                    <span className="font-medium">{o.name}</span> · {fmtDate(addDays(iv.startDate, o.cal))} {hhmm(o.start)}–{hhmm(o.end)} · <span className="text-red-700">{o.missing} of {o.need} open</span>
                    <div className="mt-0.5 text-xs text-muted">Why nobody else can take it: {(o.reasons as Any[]).map((q) => `${q.count} ${q.reason}${q.count <= 3 ? ` (${q.names.join(", ")})` : ""}`).join("; ")}</div>
                  </div>
                ))}
                {!rep?.open && openRows.map((r) => <div key={r.id} className="px-3 py-2 text-sm">{r.name} · {fmtShort(r.dutyDate)} {span(r.startsAt, r.endsAt)}</div>)}
              </Card>
            )}
          </section>

          {rep?.backup && (
            <section data-testid="backup-section">
              <h2 className="mb-1 text-base font-semibold">Backup (on call)</h2>
              <p className="mb-2 max-w-3xl text-sm text-muted">
                Chosen after the clinical schedule was final, so backup never changes who works which shift. Nobody is on backup while on a shift, on vacation or required time off,
                or during their weekly 24 hours off. Backup days are spread as evenly as the rules allow ({Object.values(rep.backup.per_resident as Record<string, number>).length
                  ? `${Math.min(...Object.values(rep.backup.per_resident as Record<string, number>))} to ${Math.max(...Object.values(rep.backup.per_resident as Record<string, number>))} per person` : "nobody"}).
              </p>
              {(rep.backup.open as Any[]).length === 0 ? <p className="text-sm text-emerald-700">Every backup day is covered.</p> : (
                <Card className="divide-y divide-line" data-testid="backup-open">
                  {(rep.backup.open as Any[]).map((o, i) => (
                    <div key={i} className="px-3 py-2 text-sm">
                      <span className="font-medium">{o.name}</span> · {fmtDate(addDays(iv.startDate, o.day))} · <span className="text-red-700">nobody on backup</span>
                      <div className="mt-0.5 text-xs text-muted">Why: {(o.reasons as Any[]).map((q) => `${q.count} ${q.reason}${q.count <= 3 ? ` (${q.names.join(", ")})` : ""}`).join("; ")}</div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          )}

          {rep?.goals && (
            <section>
              <h2 className="mb-1 text-base font-semibold">Goals, in priority order</h2>
              <p className="mb-2 max-w-3xl text-sm text-muted">The engine never gives up a goal higher in this list to improve one lower down. A score of 0 means the goal is fully met. Any other number is what is left over: sometimes these inputs make it unavoidable, sometimes more time would improve it.</p>
              <Card className="overflow-x-auto">
                <table className="w-full" data-testid="goals-table">
                  <thead className="border-b border-line bg-surface"><tr>{["", "Goal", "Result", "What the number counts"].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">
                    {(rep.goals as Any[]).map((x, i) => (
                      <tr key={x.name}>
                        <td className={cn(td, "w-8 text-muted tabular-nums")}>{i + 1}</td>
                        <td className={cn(td, "font-medium")}>{GOALS[x.name]?.label ?? x.name}</td>
                        <td className={td}>{x.score === 0 ? <Badge tone="green">Fully met</Badge> : <><span className="font-semibold tabular-nums">{g(x.score)}</span> <span className="text-xs text-muted">{x.status === "optimal" ? "(proven the best possible)" : "(best found in the time)"}</span></>}</td>
                        <td className={cn(td, "text-muted")}>{GOALS[x.name]?.counts ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>
          )}

          {rep?.residents && (
            <section>
              <h2 className="mb-2 text-base font-semibold">Per person</h2>
              <Card className="overflow-x-auto">
                <table className="w-full" data-testid="people-table">
                  <thead className="border-b border-line bg-surface"><tr>{["Participant", "Role", "Shifts", "Contract", "Hours", "Nights", "Weekend shifts", "Most hours in 7 days", "Request days not granted"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">
                    {ids.filter((p) => stats.has(p)).map((pid) => {
                      const p = byId.get(pid)!, x = stats.get(pid);
                      return (
                        <tr key={pid}>
                          <td className={td}>{p.lastName}, {p.firstName}</td><td className={td}>{p.role.name}</td>
                          <td className={cn(td, "tabular-nums", (x.shifts < x.shifts_min || x.shifts > x.shifts_max) && "font-semibold text-red-700")}>{x.shifts}</td>
                          <td className={cn(td, "tabular-nums text-muted")}>{x.shifts_min}–{x.shifts_max}</td>
                          <td className={cn(td, "tabular-nums")}>{g(x.hours)}</td><td className={cn(td, "tabular-nums")}>{x.nights}</td><td className={cn(td, "tabular-nums")}>{x.weekend_shifts}</td>
                          <td className={cn(td, "tabular-nums")}>{g(x.peak_rolling_7day_hours)}</td>
                          <td className={cn(td, x.requests_off_missed.length ? "text-red-700" : "text-muted")}>{x.requests_off_missed.length ? (x.requests_off_missed as number[]).map((d) => fmtShort(addDays(iv.startDate, d))).join(", ") : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-base font-semibold">How it was checked</h2>
            {rep?.validator ? (
              <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="checks">
                <li>After the engine finished, a separate checker went through every person&apos;s shifts by the clock: hours in every rolling 7 days, rest after each shift, a 24-hour break each week, night limits, vacation, days off, academic time and eligibility. It shares no code with the part that builds the schedule. The site also checks every shift against the role grids as they are now, on its own. Result: <strong>{violations.length === 0 ? "no hard rule broken" : `${violations.length} broken`}</strong>.</li>
                {under.map((u, i) => <li key={i} className="text-red-700">{u}</li>)}
                {((rep.precheck?.warnings ?? []) as string[]).map((w, i) => <li key={"w" + i} className="text-muted">Capacity note: {w}</li>)}
                <li className="text-muted">Engine: {rep.engine.backend === "cpsat" ? "OR-Tools CP-SAT" : "HiGHS"}, {rep.engine.strategy === "full" ? "whole program at once" : "improved a part at a time"}, {Number(rep.engine.decisions).toLocaleString("en-US")} yes/no decisions.</li>
                <li className="text-muted">Rules that are stored but not yet enforced by the engine were not checked. They are listed under <Link href={`${hub}?tab=rules&engine=stored+only`} className="text-brand hover:underline">Compiled rules</Link>.</li>
              </ul>
            ) : <p className="text-sm text-muted">This schedule was not made by the engine, so it has not been through the rule check.</p>}
          </section>
        </div>
      )}
    </>
  );
}
