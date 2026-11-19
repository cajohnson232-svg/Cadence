// A schedule as a calendar: one box per date, every shift that day with who is working it. Used on the review page
// (Calendar tab) and on the printable page. Server component: no client code.
import { DOW, addDays, cn, dayDiff, dow, hhmm } from "@/lib/util";
import { tint } from "@/lib/schedule-view";

export type CalRow = {
  participantId: string | null; name: string; institutionId: string; categoryId: string;
  dutyDate: Date; startsAt: Date; endsAt: Date; backup: boolean;
};
export type CalInstitution = { id: string; shortCode: string; name: string };

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const minute = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

/** Which institutions a calendar shows: "all", or one institution's id. */
export function calendarScope(site: string | undefined, insts: CalInstitution[]): { key: string; ids: Set<string>; title: string } {
  const one = insts.find((i) => i.id === site);
  return one ? { key: one.id, ids: new Set([one.id]), title: `${one.shortCode} only (${one.name})` }
    : { key: "all", ids: new Set(insts.map((i) => i.id)), title: `All institutions (${insts.map((i) => i.shortCode).join(" + ")})` };
}

export function ScheduleCalendar({ start, end, rows, people, insts, scope, colors, nightCats, academic, compact = false }: {
  start: Date; end: Date; rows: CalRow[]; people: Map<string, { firstName: string; lastName: string }>;
  insts: CalInstitution[]; scope: { key: string; ids: Set<string> }; colors: Map<string, string>; nightCats: Set<string>;
  academic?: Map<number, string[]>; compact?: boolean;
}) {
  const code = new Map(insts.map((i) => [i.id, i.shortCode]));
  const who = (pid: string) => { const p = people.get(pid); return p ? `${p.firstName.slice(0, 1)}. ${p.lastName}` : "?"; };
  const full = (pid: string) => { const p = people.get(pid); return p ? `${p.firstName} ${p.lastName}` : "?"; };
  const showSite = scope.ids.size > 1;

  // one line per shift per day: the people on it, and how many places are still open
  type Line = { key: string; name: string; inst: string; cat: string; start: number; end: number; startsAt: Date; endsAt: Date; backup: boolean; people: string[]; open: number };
  const byDay = new Map<number, Map<string, Line>>();
  for (const r of rows) {
    if (!scope.ids.has(r.institutionId)) continue;
    const d = dayDiff(start, r.dutyDate);
    const day = byDay.get(d) ?? new Map<string, Line>(); byDay.set(d, day);
    const k = `${r.backup ? 1 : 0}|${minute(r.startsAt)}|${r.institutionId}|${r.name}`;
    const l = day.get(k) ?? { key: k, name: r.name, inst: r.institutionId, cat: r.categoryId, start: minute(r.startsAt), end: minute(r.endsAt), startsAt: r.startsAt, endsAt: r.endsAt, backup: r.backup, people: [], open: 0 };
    if (r.participantId) l.people.push(r.participantId); else l.open++;
    day.set(k, l);
  }
  const order = (a: Line, b: Line) => Number(a.backup) - Number(b.backup) || a.start - b.start || (code.get(a.inst) ?? "").localeCompare(code.get(b.inst) ?? "") || a.name.localeCompare(b.name);

  // whole weeks, Monday to Sunday, covering the interval
  const first = addDays(start, -dow(start)), last = addDays(end, 6 - dow(end));
  const weeks = Array.from({ length: (dayDiff(first, last) + 1) / 7 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i)));

  return (
    <div className="schedule-calendar overflow-x-auto" data-testid="calendar" data-scope={scope.key}>
      <table className="w-full min-w-[980px] table-fixed border-collapse text-[11.5px] leading-[1.35] print:min-w-0 print:text-[7.5px] print:leading-[1.2]">
        <thead>
          <tr>{DOW.map((d, i) => <th key={d} className={cn("border border-line bg-surface px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted print:py-0.5", i >= 5 && "bg-slate-100")}>{d}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w} className="break-inside-avoid">
              {week.map((date, i) => {
                const d = dayDiff(start, date), inside = d >= 0 && date <= end;
                const lines = [...(byDay.get(d)?.values() ?? [])].sort(order);
                const label = date.getUTCDate() === 1 || (w === 0 && i === 0) || d === 0 ? `${MONTH[date.getUTCMonth()]} ${date.getUTCDate()}` : String(date.getUTCDate());
                return (
                  <td key={i} data-date={date.toISOString().slice(0, 10)} className={cn("h-24 border border-line p-0 align-top print:h-auto", !inside && "bg-slate-50", inside && i >= 5 && "bg-slate-50/60", compact && "h-auto")}>
                    <div className={cn("flex items-baseline justify-between px-1.5 pt-1 print:px-1 print:pt-0.5", !inside && "text-slate-300")}>
                      <span className="text-xs font-semibold" data-testid="cal-date">{label}</span>
                      {inside && academic?.get(d) && <span className="truncate pl-1 text-[10px] text-sky-700" title={academic.get(d)!.join("\n")}>{academic.get(d)!.length > 1 ? "academic ×" + academic.get(d)!.length : academic.get(d)![0]}</span>}
                    </div>
                    {inside && (
                      <ul className="px-1 pb-1 pt-0.5 print:px-0.5 print:pb-0.5 print:pt-0">
                        {lines.map((l) => (
                          <li key={l.key} data-shift={l.name} data-site={code.get(l.inst)} data-backup={l.backup || undefined}
                            title={`${l.name}${l.backup ? " (backup, on call)" : ""} · ${insts.find((x) => x.id === l.inst)?.name ?? ""}\n${hhmm(l.start)}–${hhmm(l.end)}\n${[...l.people.map(full), ...Array(l.open).fill("OPEN")].join(", ")}`}
                            className="mb-px break-words rounded-sm border-l-[3px] px-1 py-px print:py-0"
                            style={{ borderLeftColor: l.backup ? "#7c3aed" : colors.get(l.cat) ?? "#64748b", background: l.backup ? "#f5f3ff" : tint(colors.get(l.cat) ?? "#64748b", nightCats.has(l.cat) ? 22 : 12) }}>
                            <span className="font-semibold">
                              {showSite && <span className="mr-0.5 font-normal text-muted">{code.get(l.inst)}</span>}
                              {l.backup ? "Backup" : l.name}
                            </span>{" "}
                            <span>
                              {l.people.map((p, j) => <span key={p} data-person={p}>{j ? ", " : ""}{who(p)}</span>)}
                              {l.open > 0 && <span className="font-semibold text-red-700" data-open={l.open}>{l.people.length ? ", " : ""}{l.open > 1 ? `${l.open} open` : "OPEN"}</span>}
                            </span>
                          </li>
                        ))}
                        {!lines.length && <li className="px-1 text-muted">No shifts</li>}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
