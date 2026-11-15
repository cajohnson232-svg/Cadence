// Every simple admin screen is described here once: its fields, its list columns and its
// validation. The list page, the form and the save/delete actions are generic (see crud.ts).
import Link from "next/link";
import { db } from "./db";
import type { Ctx, Entity, Opt, Row, Values } from "./crud";
import { DOW, dayDiff, fmtDate, fmtHours, fmtRange, overlaps, shiftTimes, hhmm } from "./util";
import { TIMEZONES, allowance, requestDays, requestUsage, timeOffConflicts } from "./domain";
import { Badge, type Tone } from "@/components/ui/misc";
import { AreasSection, EligibilitySection, SpecialLinesSection, AcademicExtras } from "@/components/children";
import { RequestStatusButtons } from "@/components/request-buttons";

// ---- option lists -------------------------------------------------------------
const opts = {
  participants: async (c: Ctx): Promise<Opt[]> =>
    (await db.participant.findMany({ where: { programId: c.programId, archivedAt: null }, include: { role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }))
      .map((p) => ({ value: p.id, label: `${p.lastName}, ${p.firstName} (${p.role.name})` })),
  roles: async (c: Ctx): Promise<Opt[]> =>
    (await db.role.findMany({ where: { programId: c.programId, archivedAt: null }, orderBy: { level: "asc" } })).map((r) => ({ value: r.id, label: r.name })),
  institutions: async (c: Ctx): Promise<Opt[]> =>
    (await db.institution.findMany({ where: { programId: c.programId, archivedAt: null }, orderBy: { name: "asc" } })).map((i) => ({ value: i.id, label: `${i.shortCode} · ${i.name}` })),
  areas: async (c: Ctx): Promise<Opt[]> =>
    (await db.area.findMany({ where: { institution: { programId: c.programId } }, include: { institution: true }, orderBy: [{ institutionId: "asc" }, { name: "asc" }] }))
      .map((a) => ({ value: a.id, label: `${a.institution.shortCode} · ${a.name}` })),
  categories: async (c: Ctx): Promise<Opt[]> =>
    (await db.shiftCategory.findMany({ where: { programId: c.programId }, orderBy: { sortOrder: "asc" } })).map((x) => ({ value: x.id, label: x.name })),
  intervals: async (c: Ctx): Promise<Opt[]> =>
    (await db.interval.findMany({ where: { programId: c.programId }, orderBy: { startDate: "desc" } })).map((i) => ({ value: i.id, label: `${i.name} (${fmtRange(i.startDate, i.endDate)})` })),
  shifts: async (c: Ctx): Promise<Opt[]> =>
    (await db.shift.findMany({ where: { programId: c.programId, archivedAt: null }, include: { institution: true }, orderBy: [{ institutionId: "asc" }, { startMinute: "asc" }] }))
      .map((s) => ({ value: s.id, label: `${s.institution.shortCode} · ${s.name} (${shiftTimes(s.startMinute, s.durationMinutes)})` })),
};
const STATUS: Opt[] = [{ value: "APPROVED", label: "Approved" }, { value: "PENDING", label: "Pending" }, { value: "DENIED", label: "Denied" }];
const statusTone: Record<string, Tone> = { APPROVED: "green", PENDING: "amber", DENIED: "red", DRAFT: "gray", LOCKED: "amber", PUBLISHED: "green" };
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
const person = (p: Row) => `${p.lastName}, ${p.firstName}`;
const activeBadge = (r: Row) => (r.archivedAt ? <Badge>Archived</Badge> : r.active === false ? <Badge tone="amber">Inactive</Badge> : <Badge tone="green">Active</Badge>);
const active = { name: "active", label: "Active", type: "checkbox", default: "on" } as const;
const notes = (list?: string[]) =>
  list?.length ? <ul className="space-y-0.5 text-xs text-amber-800">{list.map((n, i) => <li key={i}>⚠ {n}</li>)}</ul> : <span className="text-xs text-muted">None</span>;
const errIf = (cond: unknown, field: string, msg: string) => ({ errors: (cond ? { [field]: msg } : {}) as Record<string, string> });
const endAfterStart = (v: Values, errors: Record<string, string>) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate) errors.endDate = "Must be on or after the start date";
};

const list: Entity[] = [
  // ───────────────────────────── Setup ─────────────────────────────
  {
    slug: "institutions", model: "institution", title: "Institutions", singular: "institution", archivable: true, hasActive: true,
    description: "The hospitals and sites this program staffs. Areas are the pods inside one (Trauma / Medical, GP / CC).",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "shortCode", label: "Short code", type: "text", required: true, help: "Shown on schedules, e.g. MHH" },
      { name: "timezone", label: "Timezone", type: "select", required: true, options: TIMEZONES.map((t) => ({ value: t, label: t })), default: "America/Chicago" },
      { name: "address", label: "Address", type: "textarea" },
      active,
    ],
    include: { areas: { orderBy: { name: "asc" } } }, orderBy: { name: "asc" }, search: ["name", "shortCode", "address"],
    columns: [
      { label: "Name", cell: (r) => r.name }, { label: "Code", cell: (r) => r.shortCode }, { label: "Timezone", cell: (r) => r.timezone },
      { label: "Areas", cell: (r) => r.areas.map((a: Row) => a.shortCode).join(", ") || "—" }, { label: "Status", cell: activeBadge },
    ],
    extra: async (row) => <AreasSection institution={row} />,
  },
  {
    slug: "roles", model: "role", title: "Roles", singular: "role", archivable: true, hasActive: true,
    description: "Scheduling roles such as PGY-1 or Attending. Level orders them by seniority; the default shift counts pre-fill new assignments.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "level", label: "Level / order", type: "number", required: true, min: 0, help: "Higher = more senior" },
      { name: "defaultMinShifts", label: "Default min shifts per interval", type: "number", min: 0 },
      { name: "defaultMaxShifts", label: "Default max shifts per interval", type: "number", min: 0 },
      active,
    ],
    include: { _count: { select: { participants: true } }, shiftSettings: true }, orderBy: { level: "asc" }, search: ["name"],
    columns: [
      { label: "Name", cell: (r) => r.name }, { label: "Level", cell: (r) => r.level },
      { label: "Default shifts", cell: (r) => (r.defaultMinShifts == null ? "—" : `${r.defaultMinShifts}–${r.defaultMaxShifts ?? "?"}`) },
      { label: "Participants", cell: (r) => r._count.participants },
      { label: "Not eligible for", cell: (r) => `${r.shiftSettings.filter((s: Row) => !s.eligible).length} shift(s)` }, { label: "Status", cell: activeBadge },
    ],
    validate: async (v) => errIf(v.defaultMinShifts != null && v.defaultMaxShifts != null && v.defaultMaxShifts < v.defaultMinShifts, "defaultMaxShifts", "Must be at least the minimum"),
    extra: async (row, ctx) => <EligibilitySection side="role" id={row.id} programId={ctx.programId} />,
  },
  {
    slug: "participants", model: "participant", title: "Participants", singular: "participant", archivable: true, hasActive: true,
    description: "The people being scheduled.",
    fields: [
      { name: "firstName", label: "First name", type: "text", required: true },
      { name: "lastName", label: "Last name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "tel" },
      { name: "roleId", label: "Role", type: "select", required: true, options: opts.roles },
      active,
    ],
    include: { role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], search: ["firstName", "lastName", "email"],
    filters: [{ name: "role", label: "Role", options: opts.roles, where: (v) => ({ roleId: v }) }],
    columns: [
      { label: "Name", cell: person }, { label: "Email", cell: (r) => r.email }, { label: "Phone", cell: (r) => r.phone || "—" },
      { label: "Role", cell: (r) => r.role.name }, { label: "Status", cell: activeBadge },
    ],
    extra: async (row) => (
      <section className="mt-6 max-w-4xl text-sm">
        <h2 className="text-base font-semibold">Calendar export</h2>
        <p className="mt-1 text-muted">Their published shifts and academic time as a calendar feed for Google, Apple or Outlook. The link is private to them:</p>
        <code className="mt-1 block break-all rounded border border-line bg-white px-2 py-1 text-xs">/api/calendar/{row.calendarToken}</code>
      </section>
    ),
  },
  {
    slug: "categories", model: "shiftCategory", title: "Shift categories", singular: "shift category",
    description: "Your day / evening / swing / night groupings, in forward (clockwise) rotation order. The engine uses the order for rotation and the night flag for night rules.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "sortOrder", label: "Position in the rotation", type: "number", required: true, min: 0, help: "0 = earliest in the day; shifts should move forward through these" },
      { name: "isNight", label: "Counts as a night shift", type: "checkbox" },
      { name: "balanceGroup", label: "Balance group", type: "text", help: "Categories with the same group are balanced together (e.g. Evening and Swing). Blank = on its own" },
      { name: "color", label: "Colour", type: "text", placeholder: "#fde68a" },
    ],
    include: { _count: { select: { shifts: true } } }, orderBy: { sortOrder: "asc" }, search: ["name"],
    columns: [
      { label: "Order", cell: (r) => r.sortOrder }, { label: "Name", cell: (r) => r.name }, { label: "Night", cell: (r) => (r.isNight ? <Badge tone="blue">Night</Badge> : "—") },
      { label: "Balance group", cell: (r) => r.balanceGroup || r.name }, { label: "Shifts", cell: (r) => r._count.shifts },
    ],
  },
  {
    slug: "shifts", model: "shift", title: "Shifts", singular: "shift", archivable: true, hasActive: true,
    description: "Reusable shift templates. The end time is worked out from the start and the length, so shifts that cross midnight just work.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "institutionId", label: "Institution", type: "select", required: true, options: opts.institutions },
      { name: "areaId", label: "Area", type: "select", options: opts.areas, help: "Optional. Must belong to the institution" },
      { name: "categoryId", label: "Category", type: "select", required: true, options: opts.categories },
      { name: "startMinute", label: "Start time", type: "time", required: true },
      { name: "durationMinutes", label: "Length (hours)", type: "hours", required: true, min: 0.25, max: 24, step: 0.25 },
      { name: "daysOfWeek", label: "Days of week active", type: "weekdays", required: true, default: ["0", "1", "2", "3", "4", "5", "6"], help: "The days the shift belongs to" },
      { name: "countsAsPreviousDay", label: "Starts after midnight but belongs to the evening before", type: "checkbox", help: "For overnight shifts that start at, say, 00:30" },
      { name: "minParticipants", label: "Min participants", type: "number", required: true, min: 0, default: "1" },
      { name: "maxParticipants", label: "Max participants", type: "number", required: true, min: 0, default: "1" },
      active,
    ],
    include: { institution: true, area: true, category: true, roleSettings: { include: { role: true } } },
    orderBy: [{ institutionId: "asc" }, { startMinute: "asc" }, { name: "asc" }], search: ["name"],
    filters: [
      { name: "institution", label: "Institution", options: opts.institutions, where: (v) => ({ institutionId: v }) },
      { name: "category", label: "Category", options: opts.categories, where: (v) => ({ categoryId: v }) },
    ],
    columns: [
      { label: "Name", cell: (r) => r.name }, { label: "Where", cell: (r) => `${r.institution.shortCode}${r.area ? " · " + r.area.shortCode : ""}` },
      { label: "Category", cell: (r) => r.category.name }, { label: "Time", cell: (r) => shiftTimes(r.startMinute, r.durationMinutes) },
      { label: "Length", cell: (r) => fmtHours(r.durationMinutes) },
      { label: "Days", cell: (r) => (r.daysOfWeek.length === 7 ? "Every day" : r.daysOfWeek.map((d: number) => DOW[d]).join(" ")) },
      { label: "Headcount", cell: (r) => (r.minParticipants === r.maxParticipants ? r.minParticipants : `${r.minParticipants}–${r.maxParticipants}`) },
      { label: "Roles", cell: (r) => { const no = r.roleSettings.filter((s: Row) => !s.eligible).map((s: Row) => s.role.name); return no.length ? `Not ${no.join(", ")}` : "All"; } },
      { label: "Status", cell: activeBadge },
    ],
    validate: async (v) => {
      const errors: Record<string, string> = {};
      if (v.maxParticipants < v.minParticipants) errors.maxParticipants = "Must be at least the minimum";
      if (v.areaId) {
        const a = await db.area.findUnique({ where: { id: v.areaId } });
        if (a && a.institutionId !== v.institutionId) errors.areaId = "That area belongs to a different institution";
      }
      return { errors };
    },
    extra: async (row, ctx) => <EligibilitySection side="shift" id={row.id} programId={ctx.programId} />,
  },

  // ──────────────────────────── Schedule ────────────────────────────
  {
    slug: "intervals", model: "interval", title: "Intervals", singular: "interval",
    description: "Scheduling periods: the date ranges the engine schedules at once. Open one to see its coverage, requests, adjustments and compiled rules.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true, placeholder: "Block 8" },
      { name: "startDate", label: "Start date", type: "date", required: true },
      { name: "endDate", label: "End date", type: "date", required: true },
      { name: "requestsOpen", label: "Accepting requests off", type: "checkbox", default: "on", help: "Turn off to stop residents submitting requests for this interval" },
      { name: "requestDeadline", label: "Request deadline", type: "datetime", help: "Residents can submit until then" },
      { name: "requestAllowance", label: "Request days allowed per participant", type: "number", min: 0, help: "Counted per day requested. Blank = program default" },
      { name: "highPriorityAllowance", label: "High-priority request days allowed", type: "number", min: 0, help: "Blank = program default" },
    ],
    orderBy: { startDate: "desc" }, search: ["name"], rowHref: (r) => `/intervals/${r.id}`,
    columns: [
      { label: "Name", cell: (r) => r.name }, { label: "Dates", cell: (r) => `${fmtRange(r.startDate, r.endDate)} (${dayDiff(r.startDate, r.endDate) + 1} days)` },
      { label: "Status", cell: (r) => <Badge tone={statusTone[r.status]}>{title(r.status)}</Badge> },
      { label: "Requests", cell: (r) => (r.requestsOpen ? <Badge tone="green">Open{r.requestDeadline ? ` until ${fmtDate(r.requestDeadline)}` : ""}</Badge> : <Badge>Closed</Badge>) },
    ],
    validate: async (v, ctx, id) => {
      const errors: Record<string, string> = {};
      endAfterStart(v, errors);
      if (v.startDate && v.endDate && !errors.endDate) {
        const clash = (await db.interval.findMany({ where: { programId: ctx.programId, ...(id ? { id: { not: id } } : {}) } }))
          .find((o) => overlaps(o.startDate, o.endDate, v.startDate, v.endDate));
        if (clash) errors.startDate = `Overlaps ${clash.name} (${fmtRange(clash.startDate, clash.endDate)})`;
      }
      return { errors };
    },
  },
  {
    slug: "assignments", model: "assignment", title: "Assignments", singular: "assignment",
    description: "Block-schedule assignments: a participant's contract for a date range. A participant's assignments cannot overlap.",
    fields: [
      { name: "participantId", label: "Participant", type: "select", required: true, options: opts.participants },
      { name: "startDate", label: "Start date", type: "date", required: true },
      { name: "endDate", label: "End date", type: "date", required: true },
      { name: "minShifts", label: "Min shifts", type: "number", min: 0, help: "Blank = the role's default" },
      { name: "maxShifts", label: "Max shifts", type: "number", min: 0, help: "Set equal to the minimum for an exact count" },
      { name: "institutions", label: "Institutions", type: "multi", options: opts.institutions, join: { relation: "institutions", key: "institutionId" }, required: true },
      { name: "shifts", label: "Eligible shift types", type: "multi", options: opts.shifts, join: { relation: "shifts", key: "shiftId" }, help: "Leave all unticked to allow every shift the role is eligible for" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    include: { participant: { include: { role: true } }, institutions: { include: { institution: true } }, shifts: true },
    orderBy: [{ startDate: "desc" }, { participant: { lastName: "asc" } }], search: ["participant.lastName", "participant.firstName", "notes"],
    filters: [{ name: "institution", label: "Institution", options: opts.institutions, where: (v) => ({ institutions: { some: { institutionId: v } } }) }],
    columns: [
      { label: "Participant", cell: (r) => `${person(r.participant)} (${r.participant.role.name})` }, { label: "Dates", cell: (r) => fmtRange(r.startDate, r.endDate) },
      { label: "Shifts", cell: (r) => (r.minShifts === r.maxShifts ? r.minShifts : `${r.minShifts}–${r.maxShifts}`) },
      { label: "Institutions", cell: (r) => r.institutions.map((i: Row) => i.institution.shortCode).join(", ") },
      { label: "Eligible shifts", cell: (r) => (r.shifts.length ? `${r.shifts.length} listed` : "All for role") },
    ],
    prepare: async (v) => {
      if (v.participantId && (v.minShifts == null || v.maxShifts == null)) {
        const p = await db.participant.findUnique({ where: { id: v.participantId }, include: { role: true } });
        v.minShifts ??= p?.role.defaultMinShifts ?? v.maxShifts ?? null;
        v.maxShifts ??= p?.role.defaultMaxShifts ?? v.minShifts ?? null;
      }
    },
    validate: async (v, _ctx, id) => {
      const errors: Record<string, string> = {};
      endAfterStart(v, errors);
      if (v.minShifts == null) errors.minShifts = "The role has no default; enter a number";
      else if (v.maxShifts < v.minShifts) errors.maxShifts = "Must be at least the minimum";
      if (v.participantId && v.startDate && v.endDate && !errors.endDate) {
        const clash = (await db.assignment.findMany({ where: { participantId: v.participantId, ...(id ? { id: { not: id } } : {}) } }))
          .find((o) => overlaps(o.startDate, o.endDate, v.startDate, v.endDate));
        if (clash) errors.startDate = `Overlaps this participant's assignment ${fmtRange(clash.startDate, clash.endDate)}`;
      }
      return { errors };
    },
  },
  {
    slug: "special-days", model: "specialStaffingDay", title: "Special staffing days", singular: "special staffing day",
    description: "Date-specific overrides of the normal shifts at one institution: holidays, conferences, events.",
    fields: [
      { name: "institutionId", label: "Institution", type: "select", required: true, options: opts.institutions },
      { name: "date", label: "Date", type: "date", required: true },
      { name: "name", label: "Name", type: "text", required: true, placeholder: "Thanksgiving" },
      { name: "mode", label: "What happens that day", type: "select", required: true, default: "MODIFY", options: [
        { value: "MODIFY", label: "Modify: normal shifts run, with the changes listed below" },
        { value: "REPLACE", label: "Replace: only the shifts listed below run" }] },
    ],
    include: { institution: true, shifts: { include: { shift: true }, orderBy: { id: "asc" } } }, orderBy: { date: "desc" }, search: ["name"],
    filters: [{ name: "institution", label: "Institution", options: opts.institutions, where: (v) => ({ institutionId: v }) }],
    columns: [
      { label: "Date", cell: (r) => fmtDate(r.date) }, { label: "Institution", cell: (r) => r.institution.shortCode }, { label: "Name", cell: (r) => r.name },
      { label: "Mode", cell: (r) => <Badge tone={r.mode === "REPLACE" ? "amber" : "blue"}>{title(r.mode)}</Badge> }, { label: "Lines", cell: (r) => r.shifts.length },
    ],
    validate: async (v, _ctx, id) => {
      const clash = v.institutionId && v.date ? await db.specialStaffingDay.findFirst({ where: { institutionId: v.institutionId, date: v.date, ...(id ? { id: { not: id } } : {}) } }) : null;
      return errIf(clash, "date", `${clash?.name} is already set up for that institution and date`);
    },
    extra: async (row, ctx) => <SpecialLinesSection day={row} programId={ctx.programId} />,
  },

  // ───────────────────── Time off and preferences ─────────────────────
  {
    slug: "academic-days", model: "academicDay", title: "Academic days", singular: "academic day", archivable: true, hasActive: true,
    description: "Recurring protected academic time. It is not a shift, but it appears on everyone's schedule. You decide what happens to a shift that overlaps it.",
    fields: [
      { name: "name", label: "Name", type: "text", required: true, placeholder: "Wednesday conference" },
      { name: "dayOfWeek", label: "Day of week", type: "select", numeric: true, required: true, options: DOW.map((d, i) => ({ value: String(i), label: d })) },
      { name: "startMinute", label: "Usual start time", type: "time", required: true },
      { name: "durationMinutes", label: "Usual length (hours)", type: "hours", required: true, min: 0.25, max: 24, step: 0.25 },
      { name: "startDate", label: "First date", type: "date", help: "Blank = no start limit" },
      { name: "endDate", label: "Last date", type: "date", help: "Blank = ongoing" },
      { name: "overlapPolicy", label: "If a shift overlaps the session", type: "select", required: true, default: "BLOCKED", options: [
        { value: "BLOCKED", label: "Blocked: attendees cannot be given that shift" },
        { value: "EXCUSED", label: "Excused: the shift is staffed and whoever works it is excused" }] },
      { name: "protectBeforeMinutes", label: "Protected time before (hours)", type: "hours", min: 0, max: 24, step: 0.25, default: "0", required: true },
      { name: "protectAfterMinutes", label: "Protected time after (hours)", type: "hours", min: 0, max: 24, step: 0.25, default: "0", required: true },
      { name: "roles", label: "Who attends", type: "multi", options: opts.roles, join: { relation: "roles", key: "roleId" }, help: "None ticked = every role" },
      active,
    ],
    include: { roles: { include: { role: true } }, _count: { select: { occurrences: true, exceptions: true } } }, orderBy: { name: "asc" }, search: ["name"],
    columns: [
      { label: "Name", cell: (r) => r.name }, { label: "When", cell: (r) => `${DOW[r.dayOfWeek]} ${hhmm(r.startMinute)}–${hhmm(r.startMinute + r.durationMinutes)}` },
      { label: "Dates", cell: (r) => (r.startDate || r.endDate ? `${r.startDate ? fmtDate(r.startDate) : "…"} to ${r.endDate ? fmtDate(r.endDate) : "ongoing"}` : "Ongoing") },
      { label: "Who", cell: (r) => r.roles.map((x: Row) => x.role.name).join(", ") || "Everyone" },
      { label: "Overlapping shifts", cell: (r) => <Badge tone={r.overlapPolicy === "BLOCKED" ? "amber" : "blue"}>{title(r.overlapPolicy)}</Badge> },
      { label: "Changes", cell: (r) => `${r._count.occurrences} week(s), ${r._count.exceptions} person exception(s)` }, { label: "Status", cell: activeBadge },
    ],
    validate: async (v) => { const errors: Record<string, string> = {}; endAfterStart(v, errors); return { errors }; },
    extra: async (row, ctx) => <AcademicExtras academicDayId={row.id} programId={ctx.programId} />,
  },
  {
    slug: "vacation", model: "timeOff", title: "Vacation", singular: "vacation", where: { kind: "VACATION" }, fixed: { kind: "VACATION", mandatory: false, priority: null }, stamp: true,
    description: "Approved vacation is never scheduled. Pending or denied vacation is not sent to the engine.",
    fields: [
      { name: "participantId", label: "Participant", type: "select", required: true, options: opts.participants },
      { name: "startDate", label: "First day", type: "date", required: true },
      { name: "endDate", label: "Last day", type: "date", required: true },
      { name: "status", label: "Status", type: "select", required: true, options: STATUS, default: "APPROVED" },
      { name: "reason", label: "Reason", type: "text" },
    ],
    include: { participant: true, interval: true }, orderBy: { startDate: "desc" }, search: ["participant.lastName", "participant.firstName", "reason"],
    filters: [{ name: "status", label: "Status", options: STATUS, where: (v) => ({ status: v }) }],
    columns: [
      { label: "Participant", cell: (r) => person(r.participant) }, { label: "Dates", cell: (r) => `${fmtRange(r.startDate, r.endDate)} (${requestDays(r)} days)` },
      { label: "Status", cell: (r) => <Badge tone={statusTone[r.status]}>{title(r.status)}</Badge> }, { label: "Reason", cell: (r) => r.reason || "—" },
      { label: "Conflicts", cell: (r) => notes(r._conflicts) },
    ],
    decorate: async (rows, ctx) => { const m = await timeOffConflicts(ctx.programId, rows); rows.forEach((r) => (r._conflicts = m.get(r.id))); },
    validate: async (v, _ctx, id) => {
      const errors: Record<string, string> = {};
      endAfterStart(v, errors);
      if (v.participantId && v.startDate && v.endDate && !errors.endDate) {
        const clash = (await db.timeOff.findMany({ where: { participantId: v.participantId, kind: "VACATION", status: { not: "DENIED" }, ...(id ? { id: { not: id } } : {}) } }))
          .find((o) => overlaps(o.startDate, o.endDate, v.startDate, v.endDate));
        if (clash) errors.startDate = `Overlaps their vacation ${fmtRange(clash.startDate, clash.endDate)}`;
      }
      return { errors };
    },
  },
  {
    slug: "requests", model: "timeOff", title: "Requests off", singular: "request off", stamp: true,
    where: { kind: { in: ["REQUEST_OFF", "FIRST_DAY_OFF", "LAST_DAY_OFF"] } },
    description: "Requests are counted per day against each participant's allowance for the interval. Only approved requests reach the engine. First and last day off are preset requests.",
    fields: [
      { name: "participantId", label: "Participant", type: "select", required: true, options: opts.participants },
      { name: "intervalId", label: "Interval", type: "select", required: true, options: opts.intervals },
      { name: "kind", label: "Type", type: "select", required: true, default: "REQUEST_OFF", options: [
        { value: "REQUEST_OFF", label: "Request off (pick the dates)" },
        { value: "FIRST_DAY_OFF", label: "First day off (first day of the interval or of their assignment)" },
        { value: "LAST_DAY_OFF", label: "Last day off (last day of the interval or of their assignment)" }] },
      { name: "startDate", label: "First day", type: "date", help: "Not needed for first / last day off" },
      { name: "endDate", label: "Last day", type: "date", help: "Leave blank for a single day" },
      { name: "priority", label: "Priority", type: "select", options: [{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }], default: "MEDIUM" },
      { name: "mandatory", label: "Mandatory (becomes a hard rule: never scheduled)", type: "checkbox" },
      { name: "status", label: "Status", type: "select", required: true, options: STATUS, default: "APPROVED" },
      { name: "reason", label: "Reason", type: "text" },
      { name: "allowanceOverride", label: "Save even if this goes over the allowance", type: "checkbox" },
    ],
    include: { participant: true, interval: true }, orderBy: [{ startDate: "desc" }], search: ["participant.lastName", "participant.firstName", "reason"],
    filters: [
      { name: "interval", label: "Interval", options: opts.intervals, where: (v) => ({ intervalId: v }) },
      { name: "status", label: "Status", options: STATUS, where: (v) => ({ status: v }) },
    ],
    columns: [
      { label: "Participant", cell: (r) => person(r.participant) }, { label: "Interval", cell: (r) => r.interval?.name ?? "—" },
      { label: "Type", cell: (r) => title(r.kind) }, { label: "Dates", cell: (r) => `${fmtRange(r.startDate, r.endDate)}${requestDays(r) > 1 ? ` (${requestDays(r)} days)` : ""}` },
      { label: "Priority", cell: (r) => (r.mandatory ? <Badge tone="red">Mandatory</Badge> : <Badge tone={r.priority === "HIGH" ? "amber" : "gray"}>{title(r.priority ?? "—")}</Badge>) },
      { label: "Status", cell: (r) => <div className="flex flex-wrap items-center gap-1.5"><Badge tone={statusTone[r.status]}>{title(r.status)}</Badge><RequestStatusButtons id={r.id} status={r.status} /></div> },
      { label: "Allowance", cell: (r) => (r._usage ? <span className={r._usage.over ? "font-medium text-red-700" : ""}>{r._usage.text}{r.allowanceOverride ? " (override)" : ""}</span> : "—") },
      { label: "Conflicts", cell: (r) => notes(r._conflicts) },
    ],
    decorate: async (rows, ctx) => {
      const m = await timeOffConflicts(ctx.programId, rows);
      const cache = new Map<string, { text: string; over: boolean }>();
      for (const r of rows) {
        r._conflicts = m.get(r.id);
        if (!r.intervalId) continue;
        const key = r.intervalId + r.participantId;
        if (!cache.has(key)) {
          const [a, u] = await Promise.all([allowance(r.intervalId), requestUsage(r.intervalId, r.participantId)]);
          cache.set(key, { text: `${u.days} of ${a.days} days, ${u.high} of ${a.high} high`, over: u.days > a.days || u.high > a.high });
        }
        r._usage = cache.get(key);
      }
    },
    prepare: async (v) => {
      if (!v.intervalId || !v.participantId) return;
      const iv = await db.interval.findUnique({ where: { id: v.intervalId } });
      if (!iv) return;
      if (v.kind === "FIRST_DAY_OFF" || v.kind === "LAST_DAY_OFF") {
        // the first / last day this person is actually here within the interval
        const mine = (await db.assignment.findMany({ where: { participantId: v.participantId } })).filter((a) => overlaps(a.startDate, a.endDate, iv.startDate, iv.endDate));
        const first = mine.length ? new Date(Math.max(iv.startDate.getTime(), Math.min(...mine.map((a) => a.startDate.getTime())))) : iv.startDate;
        const last = mine.length ? new Date(Math.min(iv.endDate.getTime(), Math.max(...mine.map((a) => a.endDate.getTime())))) : iv.endDate;
        v.startDate = v.endDate = v.kind === "FIRST_DAY_OFF" ? first : last;
      } else if (v.startDate && !v.endDate) v.endDate = v.startDate;
      if (v.mandatory) v.priority = null;
    },
    validate: async (v, _ctx, id) => {
      const errors: Record<string, string> = {};
      if (!v.startDate) errors.startDate = "Required for a request off";
      endAfterStart(v, errors);
      if (!v.mandatory && !v.priority) errors.priority = "Choose a priority, or tick Mandatory";
      if (!v.intervalId || !v.participantId || !v.startDate || errors.endDate) return { errors };
      const a = await allowance(v.intervalId);
      if (v.startDate < a.interval.startDate || v.endDate > a.interval.endDate) errors.startDate = `Must fall inside ${a.interval.name} (${fmtRange(a.interval.startDate, a.interval.endDate)})`;
      if (v.kind === "REQUEST_OFF" && v.status !== "DENIED" && !v.allowanceOverride) {
        const u = await requestUsage(v.intervalId, v.participantId, id);
        const days = requestDays(v as { startDate: Date; endDate: Date });
        if (u.days + days > a.days) errors.allowanceOverride = `This takes them to ${u.days + days} of ${a.days} request days. Tick the box to save anyway.`;
        else if (v.priority === "HIGH" && u.high + days > a.high) errors.allowanceOverride = `This takes them to ${u.high + days} of ${a.high} high-priority days. Tick the box to save anyway.`;
      }
      return { errors };
    },
  },
  {
    slug: "adjustments", model: "shiftAdjustment", title: "Adjustments", singular: "adjustment", stamp: true,
    description: "Shift reductions and penalties: move a participant's required shift count for an interval up or down, with a reason.",
    fields: [
      { name: "participantId", label: "Participant", type: "select", required: true, options: opts.participants },
      { name: "intervalId", label: "Interval", type: "select", required: true, options: opts.intervals },
      { name: "delta", label: "Change in shifts", type: "number", required: true, min: -31, max: 31, help: "-2 for chief duties, +1 for a make-up shift" },
      { name: "reason", label: "Reason", type: "text", required: true },
    ],
    include: { participant: true, interval: true }, orderBy: { createdAt: "desc" }, search: ["participant.lastName", "participant.firstName", "reason"],
    filters: [{ name: "interval", label: "Interval", options: opts.intervals, where: (v) => ({ intervalId: v }) }],
    columns: [
      { label: "Participant", cell: (r) => person(r.participant) }, { label: "Interval", cell: (r) => <Link className="text-brand hover:underline" href={`/intervals/${r.intervalId}?tab=adjustments`}>{r.interval.name}</Link> },
      { label: "Change", cell: (r) => <span className={r.delta < 0 ? "text-emerald-700" : "text-amber-700"}>{r.delta > 0 ? "+" : ""}{r.delta} shift(s)</span> }, { label: "Reason", cell: (r) => r.reason },
    ],
    validate: async (v) => errIf(v.delta === 0, "delta", "Enter a change other than 0"),
  },
];

export const ENTITIES: Record<string, Entity> = Object.fromEntries(list.map((e) => [e.slug, e]));
