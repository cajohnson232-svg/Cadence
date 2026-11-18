// Child rows edited on a parent's page: areas, the shift x role grid, special-day lines,
// and the weekly changes / personal exceptions of an academic day.
import { db } from "@/lib/db";
import type { Row } from "@/lib/crud";
import { addArea, addException, addOccurrence, addSpecialLine, deleteAcademicChild, deleteArea, deleteSpecialLine, saveEligibility } from "@/app/actions";
import { Button } from "./ui/button";
import { Input, Label, Select } from "./ui/input";
import { Badge, Card, td, th } from "./ui/misc";
import { fmtDate, fmtHours, hhmm, shiftTimes } from "@/lib/util";

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="mt-6 max-w-4xl">
    <h2 className="text-base font-semibold">{title}</h2>
    {hint && <p className="mb-2 mt-0.5 text-sm text-muted">{hint}</p>}
    <Card className="mt-2 overflow-x-auto">{children}</Card>
  </section>
);
const Del = ({ action, label = "Remove" }: { action: () => Promise<void>; label?: string }) => (
  <form action={action}><button className="text-xs text-red-700 hover:underline">{label}</button></form>
);

export function AreasSection({ institution }: { institution: Row }) {
  return (
    <Section title="Areas" hint="Pods or zones inside this institution. Shifts can be tied to an area, and two areas can be balanced against each other by a rule.">
      <table className="w-full">
        <thead className="border-b border-line bg-surface"><tr><th className={th}>Name</th><th className={th}>Code</th><th className={th} /></tr></thead>
        <tbody className="divide-y divide-line">
          {institution.areas.map((a: Row) => (
            <tr key={a.id}><td className={td}>{a.name}</td><td className={td}>{a.shortCode}</td><td className={td}><Del action={deleteArea.bind(null, a.id)} /></td></tr>
          ))}
          {!institution.areas.length && <tr><td className="px-3 py-4 text-sm text-muted" colSpan={3}>No areas yet.</td></tr>}
        </tbody>
      </table>
      <form action={addArea.bind(null, institution.id)} className="flex flex-wrap items-end gap-2 border-t border-line p-3">
        <div><Label htmlFor="area-name">New area</Label><Input id="area-name" name="name" placeholder="Trauma" className="w-48" /></div>
        <div><Label htmlFor="area-code">Code</Label><Input id="area-code" name="shortCode" placeholder="T" className="w-24" /></div>
        <Button variant="outline" size="sm">Add area</Button>
      </form>
    </Section>
  );
}

export async function EligibilitySection({ side, id, programId }: { side: "shift" | "role"; id: string; programId: string }) {
  const [roles, shifts, settings] = await Promise.all([
    db.role.findMany({ where: { programId, archivedAt: null }, orderBy: { level: "asc" } }),
    db.shift.findMany({ where: { programId, archivedAt: null }, include: { institution: true }, orderBy: [{ institutionId: "asc" }, { startMinute: "asc" }] }),
    db.shiftRole.findMany({ where: side === "shift" ? { shiftId: id } : { roleId: id } }),
  ]);
  const get = (key: string) => settings.find((s) => (side === "shift" ? s.roleId : s.shiftId) === key);
  const rows = side === "shift" ? roles.map((r) => ({ key: r.id, label: r.name, sub: `Level ${r.level}` }))
    : shifts.map((s) => ({ key: s.id, label: s.name, sub: `${s.institution.shortCode} · ${shiftTimes(s.startMinute, s.durationMinutes)}` }));
  return (
    <Section title={side === "shift" ? "Roles for this shift" : "Shifts this role is eligible for"}
      hint={side === "shift" ? "Tick who may work this shift, and how many of each role it requires." : "Untick any shift this role may not work. Required headcounts are set on each shift."}>
      <form action={saveEligibility.bind(null, side, id)}>
        <table className="w-full">
          <thead className="border-b border-line bg-surface"><tr>
            <th className={th}>{side === "shift" ? "Role" : "Shift"}</th><th className={th}>Eligible</th>{side === "shift" && <th className={th}>Required headcount</th>}
          </tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const cur = get(r.key);
              return (
                <tr key={r.key}>
                  <td className={td}>{r.label} <span className="text-xs text-muted">{r.sub}</span></td>
                  <td className={td}><input type="checkbox" name={`elig_${r.key}`} defaultChecked={cur ? cur.eligible : true} aria-label={`${r.label} eligible`} className="size-4 accent-[var(--color-brand)]" /></td>
                  {side === "shift" && <td className={td}><Input type="number" min={0} name={`req_${r.key}`} defaultValue={cur?.requiredCount ?? 0} className="h-8 w-20" aria-label={`${r.label} required`} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-line p-3"><Button variant="outline" size="sm">Save eligibility</Button></div>
      </form>
    </Section>
  );
}

export async function SpecialLinesSection({ day, programId }: { day: Row; programId: string }) {
  const [shifts, cats] = await Promise.all([
    db.shift.findMany({ where: { programId, institutionId: day.institutionId, archivedAt: null }, orderBy: { startMinute: "asc" } }),
    db.shiftCategory.findMany({ where: { programId }, orderBy: { sortOrder: "asc" } }),
  ]);
  const describe = (l: Row) => {
    const start = l.startMinute ?? l.shift?.startMinute, dur = l.durationMinutes ?? l.shift?.durationMinutes;
    const min = l.minParticipants ?? l.shift?.minParticipants, max = l.maxParticipants ?? l.shift?.maxParticipants;
    return { name: l.name ?? l.shift?.name ?? "—", time: start != null && dur ? `${shiftTimes(start, dur)} (${fmtHours(dur)})` : "—", head: min == null ? "—" : min === max ? String(min) : `${min}–${max}` };
  };
  return (
    <Section title="What changes that day" hint={day.mode === "REPLACE" ? "Only the shifts listed here run at this institution on this date." : "The normal shifts run, with these additions, changes and removals."}>
      <table className="w-full">
        <thead className="border-b border-line bg-surface"><tr><th className={th}>Action</th><th className={th}>Shift</th><th className={th}>Time</th><th className={th}>Headcount</th><th className={th} /></tr></thead>
        <tbody className="divide-y divide-line">
          {day.shifts.map((l: Row) => { const d = describe(l); return (
            <tr key={l.id}>
              <td className={td}><Badge tone={l.action === "REMOVE" ? "red" : l.action === "ADD" ? "green" : "blue"}>{l.action.charAt(0) + l.action.slice(1).toLowerCase()}</Badge></td>
              <td className={td}>{d.name}{l.shift && l.name ? <span className="text-xs text-muted"> (from {l.shift.name})</span> : null}</td>
              <td className={td}>{l.action === "REMOVE" ? "Does not run" : d.time}</td><td className={td}>{l.action === "REMOVE" ? "—" : d.head}</td>
              <td className={td}><Del action={deleteSpecialLine.bind(null, l.id)} /></td>
            </tr>); })}
          {!day.shifts.length && <tr><td className="px-3 py-4 text-sm text-muted" colSpan={5}>No lines yet{day.mode === "REPLACE" ? ": as it stands, nothing runs that day." : "."}</td></tr>}
        </tbody>
      </table>
      <form action={addSpecialLine.bind(null, day.id)} className="grid gap-3 border-t border-line p-3 sm:grid-cols-4">
        <div><Label htmlFor="l-action">Action</Label><Select id="l-action" name="action" defaultValue="CHANGE"><option value="CHANGE">Change a normal shift</option><option value="REMOVE">Remove a normal shift</option><option value="ADD">Add a shift</option></Select></div>
        <div className="sm:col-span-2"><Label htmlFor="l-shift">Normal shift</Label><Select id="l-shift" name="shiftId" defaultValue=""><option value="">— (brand-new shift)</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({shiftTimes(s.startMinute, s.durationMinutes)})</option>)}</Select></div>
        <div><Label htmlFor="l-name">Name that day</Label><Input id="l-name" name="name" placeholder="Holiday Day T" /></div>
        <div><Label htmlFor="l-cat">Category</Label><Select id="l-cat" name="categoryId" defaultValue=""><option value="">Same as normal</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
        <div><Label htmlFor="l-start">Start time</Label><Input id="l-start" name="start" type="time" /></div>
        <div><Label htmlFor="l-hours">Length (hours)</Label><Input id="l-hours" name="hours" type="number" step={0.25} min={0.25} max={24} /></div>
        <div className="flex gap-2"><div><Label htmlFor="l-min">Min</Label><Input id="l-min" name="min" type="number" min={0} /></div><div><Label htmlFor="l-max">Max</Label><Input id="l-max" name="max" type="number" min={0} /></div></div>
        <div className="sm:col-span-4"><Button variant="outline" size="sm">Add line</Button> <span className="ml-2 text-xs text-muted">Leave a field blank to keep the normal shift&apos;s value.</span></div>
      </form>
    </Section>
  );
}

export async function AcademicExtras({ academicDayId, programId }: { academicDayId: string; programId: string }) {
  const [occ, exc, people] = await Promise.all([
    db.academicDayOccurrence.findMany({ where: { academicDayId }, orderBy: { date: "asc" } }),
    db.academicDayException.findMany({ where: { academicDayId }, include: { participant: true }, orderBy: { startDate: "asc" } }),
    db.participant.findMany({ where: { programId, archivedAt: null }, orderBy: [{ lastName: "asc" }] }),
  ]);
  const off = occ.filter((o) => o.cancelled), changed = occ.filter((o) => !o.cancelled);
  return (
    <>
      <Section title="Dates it does not happen" hint="Holidays and other dates the session is not held. Nobody attends, and shifts that day are scheduled normally.">
        <div className="flex flex-wrap gap-2 p-3" data-testid="skip-dates">
          {off.map((o) => (
            <span key={o.id} className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1 text-sm">{fmtDate(o.date)}
              <Del action={deleteAcademicChild.bind(null, "occurrence", o.id)} /></span>
          ))}
          {!off.length && <span className="text-sm text-muted">It happens every week in its date range.</span>}
        </div>
        <form action={addOccurrence.bind(null, academicDayId)} className="flex flex-wrap items-end gap-3 border-t border-line p-3">
          <input type="hidden" name="cancelled" value="on" />
          <div><Label htmlFor="skip-date">Date</Label><Input id="skip-date" name="date" type="date" required className="w-40" /></div>
          <Button variant="outline" size="sm">Add date</Button>
        </form>
      </Section>
      <Section title="Weeks that differ" hint="A single session at a different time or length, or with a different overlap setting.">
        <table className="w-full">
          <thead className="border-b border-line bg-surface"><tr><th className={th}>Date</th><th className={th}>Change</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-line">
            {changed.map((o) => (
              <tr key={o.id}><td className={td}>{fmtDate(o.date)}</td>
                <td className={td}>{o.cancelled ? <Badge tone="red">Cancelled</Badge> : [o.startMinute != null && `starts ${hhmm(o.startMinute)}`, o.durationMinutes && `lasts ${fmtHours(o.durationMinutes)}`, o.overlapPolicy && `overlapping shifts ${o.overlapPolicy.toLowerCase()}`].filter(Boolean).join(", ") || "No change"}</td>
                <td className={td}><Del action={deleteAcademicChild.bind(null, "occurrence", o.id)} /></td></tr>
            ))}
            {!changed.length && <tr><td className="px-3 py-4 text-sm text-muted" colSpan={3}>Every week follows the usual time.</td></tr>}
          </tbody>
        </table>
        <form action={addOccurrence.bind(null, academicDayId)} className="flex flex-wrap items-end gap-3 border-t border-line p-3">
          <div><Label htmlFor="o-date">Date</Label><Input id="o-date" name="date" type="date" className="w-40" /></div>
          <div><Label htmlFor="o-start">Start</Label><Input id="o-start" name="start" type="time" className="w-28" /></div>
          <div><Label htmlFor="o-hours">Hours</Label><Input id="o-hours" name="hours" type="number" step={0.25} min={0.25} max={24} className="w-24" /></div>
          <div><Label htmlFor="o-policy">Can&apos;t work an overlapping shift?</Label><Select id="o-policy" name="policy" defaultValue="" className="w-36"><option value="">As usual</option><option value="BLOCKED">Yes</option><option value="EXCUSED">No</option></Select></div>
          <Button variant="outline" size="sm">Add</Button>
        </form>
      </Section>
      <Section title="Personal exceptions" hint="Someone excused although their role attends, or required although it does not.">
        <table className="w-full">
          <thead className="border-b border-line bg-surface"><tr><th className={th}>Participant</th><th className={th}>Exception</th><th className={th}>Dates</th><th className={th}>Reason</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-line">
            {exc.map((x) => (
              <tr key={x.id}><td className={td}>{x.participant.lastName}, {x.participant.firstName}</td>
                <td className={td}><Badge tone={x.type === "EXCUSED" ? "blue" : "amber"}>{x.type === "EXCUSED" ? "Excused" : "Required"}</Badge></td>
                <td className={td}>{x.startDate ? `${fmtDate(x.startDate)}${x.endDate && +x.endDate !== +x.startDate ? " to " + fmtDate(x.endDate) : ""}` : "Always"}</td>
                <td className={td}>{x.reason || "—"}</td><td className={td}><Del action={deleteAcademicChild.bind(null, "exception", x.id)} /></td></tr>
            ))}
            {!exc.length && <tr><td className="px-3 py-4 text-sm text-muted" colSpan={5}>No exceptions.</td></tr>}
          </tbody>
        </table>
        <form action={addException.bind(null, academicDayId)} className="flex flex-wrap items-end gap-3 border-t border-line p-3">
          <div><Label htmlFor="x-p">Participant</Label><Select id="x-p" name="participantId" defaultValue="" className="w-52"><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.lastName}, {p.firstName}</option>)}</Select></div>
          <div><Label htmlFor="x-t">Exception</Label><Select id="x-t" name="type" defaultValue="EXCUSED" className="w-32"><option value="EXCUSED">Excused</option><option value="REQUIRED">Required</option></Select></div>
          <div><Label htmlFor="x-a">From</Label><Input id="x-a" name="startDate" type="date" className="w-40" /></div>
          <div><Label htmlFor="x-b">To</Label><Input id="x-b" name="endDate" type="date" className="w-40" /></div>
          <div><Label htmlFor="x-r">Reason</Label><Input id="x-r" name="reason" className="w-44" /></div>
          <Button variant="outline" size="sm">Add</Button>
        </form>
      </Section>
    </>
  );
}
