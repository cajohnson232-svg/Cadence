// The bridge from the database to the scheduling engine.
//
//   compileInterval(id) -> { config, compiledRules, warnings }
//
//   config          the engine's input for that interval
//   compiledRules   ONE uniform list: every rule, vacation, request, preset, academic series,
//                   special staffing day and contract that applies, each marked as enforced by
//                   the engine, stored only, needs review, or not included
//   warnings        what an admin should know before running
//
// Started as a port of datamodel/compile_interval.py; since 17 Nov 2026 it does more (splits, backup shifts,
// required time off, personal academic days, entered prior shifts) and is the one the app uses.
import { cleanBackupRules, describeBackupRules } from "./backup-rules";
import { db } from "./db";
import { academicSessions } from "./domain";
import { REQUESTS_PRIORITY, TEMPLATE, engineStatus, ruleText } from "./rule-templates";
import { addDays, dayDiff, dow, eachDay, hhmm, ymd } from "./util";
import { categoryKeys, siteKeys } from "./engine-keys";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export type Compiled = {
  origin: string; id: string; template: string; text: string; scope: string; appliesTo: string; level: string;
  weight?: number | null; priority?: number | null; from?: string | null; to?: string | null; source?: string; engine: string; note?: string | null;
};
const WEIGHT: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const ENGINE_GOAL_ORDER = ["forward_rotation", "balance_shift_categories", "min_days_between_night_runs", "no_night_before_time_off",
  "max_night_fraction", "balance_areas", "consecutive_days_off", "single_night_run"];

export async function compileInterval(intervalId: string) {
  const warn: string[] = [];
  const compiled: Compiled[] = [];
  const iv = await db.interval.findUniqueOrThrow({ where: { id: intervalId } });
  const pid = iv.programId, start = iv.startDate, end = iv.endDate;
  const n = dayDiff(start, end) + 1;
  const idx = (d: Date) => dayDiff(start, d);
  const inside = (d: Date) => start <= d && d <= end;

  const [roleList, catList, instList, areaList, peopleList] = await Promise.all([
    db.role.findMany({ where: { programId: pid } }),
    db.shiftCategory.findMany({ where: { programId: pid }, orderBy: { sortOrder: "asc" } }),
    db.institution.findMany({ where: { programId: pid } }),
    db.area.findMany({ where: { institution: { programId: pid } } }),
    db.participant.findMany({ where: { programId: pid, active: true, archivedAt: null }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
  ]);
  const by = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x])) as Record<string, T>;
  const roles = by(roleList), cats = by(catList), insts = by(instList), areas = by(areaList), people = by(peopleList);
  // the keys the engine knows institutions and categories by: unique even when short codes or names repeat
  const siteOf = siteKeys(instList), catOf = categoryKeys(catList);
  const site = (id: string) => siteOf.get(id) ?? id, cat = (id: string) => catOf.get(id) ?? id;
  const pname = (p: string | null) => (p && people[p] ? `${people[p].firstName} ${people[p].lastName}` : p ?? "");
  const shiftsAll = await db.shift.findMany({ where: { programId: pid } });
  const names: Record<string, string> = {
    ...Object.fromEntries(catList.map((c) => [c.id, c.name])), ...Object.fromEntries(instList.map((i) => [i.id, i.name])),
    ...Object.fromEntries(areaList.map((a) => [a.id, a.name])), ...Object.fromEntries(roleList.map((r) => [r.id, r.name])),
    ...Object.fromEntries(peopleList.map((p) => [p.id, pname(p.id)])), ...Object.fromEntries(shiftsAll.map((s) => [s.id, s.name])),
  };

  // ---------------- rules in force during the interval ----------------
  const rules = await db.rule.findMany({
    where: { programId: pid, enabled: true, archivedAt: null, AND: [{ OR: [{ activeFrom: null }, { activeFrom: { lte: end } }] }, { OR: [{ activeTo: null }, { activeTo: { gte: start } }] }] },
    orderBy: [{ level: "asc" }, { priority: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  });
  const target = (r: Any) => ({ PROGRAM: "Whole program", INSTITUTION: insts[r.institutionId]?.name, ROLE: roles[r.roleId]?.name, PARTICIPANT: pname(r.participantId) } as Any)[r.scope] ?? "";
  const live: Any[] = [];
  for (const r of rules) {
    const { status, note } = engineStatus(r);
    if (status === "needs review" && note === "invalid parameters") warn.push(`Rule "${TEMPLATE[r.template]?.label ?? r.template}" for ${target(r)}: parameters do not match the template.`);
    if (status === "enforced") live.push(r);
    compiled.push({ origin: "Rule", id: r.id, template: r.template, text: ruleText(r.template, r.params, names), scope: r.scope, appliesTo: target(r), level: r.level,
      weight: r.weight, priority: r.priority, from: r.activeFrom ? ymd(r.activeFrom) : null, to: r.activeTo ? ymd(r.activeTo) : null, source: r.source, engine: status, note });
  }
  const one = (template: string, key: string, dflt: number) => {
    const got = live.filter((r) => r.template === template && r.scope === "PROGRAM");
    if (!got.length) { warn.push(`No active program rule '${TEMPLATE[template].label}': the engine default (${dflt}) applies.`); return dflt; }
    return got[0].params[key] ?? dflt;
  };
  const cfgRules: Any = {
    max_week_hours: one("max_hours_rolling_week", "hours", 60), rest_ratio: one("rest_equal_to_shift_length", "ratio", 1),
    max_nights: one("max_nights_per_interval", "n", 8), max_night_runs: one("max_night_runs", "n", 2),
    min_gap_between_night_runs: one("min_days_between_night_runs", "days", 7), max_night_fraction_pct: one("max_night_fraction", "percent", 45),
    soft_max_nights_in_run: one("single_night_run", "max_length", 6), balance_tolerance_shifts: one("balance_shift_categories", "tolerance_shifts", 1),
    max_consecutive_days: one("max_days_in_a_row", "n", 6),
  };
  const rest = live.filter((r) => r.template === "min_hours_off_between_shifts").map((r) => r.params.hours);
  if (rest.length) cfgRules.min_rest_hours = Math.max(...rest);
  for (const always of ["one_day_off_in_seven", "forward_rotation", "consecutive_days_off", "no_night_before_time_off"])
    if (!live.some((r) => r.template === always)) warn.push(`'${TEMPLATE[always].label}' is not active, but the engine always applies it.`);
  const pairs = live.filter((r) => r.template === "balance_areas" && areas[r.params.area_a] && areas[r.params.area_b]);
  const podPairs = pairs.map((r) => [site(areas[r.params.area_a].institutionId), areas[r.params.area_a].shortCode, areas[r.params.area_b].shortCode]);
  if (pairs.length) cfgRules.pod_tolerance_shifts = Math.min(...pairs.map((r) => r.params.tolerance_shifts));
  const order = live.filter((r) => r.level === "SOFT" && r.priority).sort((a, b) => a.priority - b.priority).map((r) => r.template);
  const seen = [...new Set(order)].filter((t) => ENGINE_GOAL_ORDER.includes(t));
  if (seen.join() !== ENGINE_GOAL_ORDER.filter((t) => seen.includes(t)).join()) warn.push("Soft-rule priorities differ from the engine's built-in order; the engine's order is used for now.");

  // ---------------- shift templates, with special staffing days folded in ----------------
  // backup (on-call) shifts are scheduled separately, after the clinical schedule; one that "counts as a shift" is an ordinary shift
  const isOnCall = (s: Any) => s.isBackup && !cleanBackupRules(s.backupRules).counts_as_shift;
  const backupList = shiftsAll.filter((s) => s.active && !s.archivedAt && isOnCall(s)).sort((a, b) => a.id.localeCompare(b.id));
  const shiftList = shiftsAll.filter((s) => s.active && !s.archivedAt && !isOnCall(s)).sort((a, b) => a.id.localeCompare(b.id));
  const shifts = by(shiftList);
  const eligRows = await db.shiftRole.findMany({ where: { shiftId: { in: shiftsAll.map((s) => s.id) } } });
  const elig = new Map(eligRows.map((e) => [e.shiftId + "|" + e.roleId, e]));
  const isElig = (sid: string, rid: string) => elig.get(sid + "|" + rid)?.eligible ?? true;
  const levels = roleList.map((r) => r.level);
  const minLevel = (sid: string) => { const ok = roleList.filter((r) => isElig(sid, r.id)).map((r) => r.level); return ok.length ? Math.min(...ok) : Math.max(...levels) + 1; };
  const template = (s: Any, over: Any = {}) => {
    const g = { ...s, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== null && v !== undefined)) };
    return {
      name: g.name, ref: s.id ?? g.name, site: site(g.institutionId), pod: g.areaId ? areas[g.areaId].shortCode : "", category: cat(g.categoryId),
      start: hhmm(g.startMinute), hours: g.durationMinutes / 60, headcount: g.minParticipants, max_headcount: Math.max(g.maxParticipants ?? 0, g.minParticipants), min_pgy: s.id ? minLevel(s.id) : 1,
      counts_as_previous_day: !!g.countsAsPreviousDay, weekdays: [...(g.daysOfWeek ?? [])], except_days: [] as number[],
    } as Any;
  };
  const tmpl: Record<string, Any> = Object.fromEntries(shiftList.map((s) => [s.id, template(s)]));
  for (const s of shiftList) {
    if (eligRows.filter((e) => e.shiftId === s.id).reduce((a, e) => a + e.requiredCount, 0)) warn.push(`${s.name}: per-role headcounts are stored but the engine staffs to the total only.`);
  }
  const dated: Any[] = [];
  const special = await db.specialStaffingDay.findMany({ where: { programId: pid, date: { gte: start, lte: end } }, include: { shifts: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
  for (const sd of special) {
    const d = idx(sd.date), wd = dow(sd.date);
    if (sd.mode === "REPLACE") for (const s of shiftList) if (s.institutionId === sd.institutionId && s.daysOfWeek.includes(wd)) tmpl[s.id].except_days.push(d);
    for (const ln of sd.shifts) {
      const base = ln.shiftId ? shifts[ln.shiftId] ?? shiftsAll.find((x) => x.id === ln.shiftId) : undefined;     // a replacement may copy an inactive shift
      if ((ln.action === "CHANGE" || ln.action === "REMOVE") && sd.mode === "MODIFY" && ln.shiftId && tmpl[ln.shiftId]) tmpl[ln.shiftId].except_days.push(d);
      if (ln.action === "REMOVE") continue;
      if (!base) warn.push(`${sd.name}: an extra shift (${ln.name ?? "unnamed"}) does not say which normal shift it is like, so nobody can be scheduled on it. Open the special day and choose one.`);
      const src: Any = base ? { ...base } : { minParticipants: 1, id: `line:${ln.id}` };
      src.institutionId = sd.institutionId;
      const t = template(src, { categoryId: ln.categoryId, areaId: ln.areaId, startMinute: ln.startMinute, durationMinutes: ln.durationMinutes,
        countsAsPreviousDay: ln.countsAsPreviousDay, minParticipants: ln.minParticipants, maxParticipants: ln.maxParticipants, name: ln.name ?? `${base?.name} (${sd.name})` });
      delete t.weekdays; delete t.except_days;
      t.only_days = [d]; t.special_ref = ln.id;
      dated.push(t);
    }
    compiled.push({ origin: "Special staffing day", id: sd.id, template: "special_staffing", scope: "INSTITUTION", appliesTo: insts[sd.institutionId].name, level: "HARD",
      from: ymd(sd.date), to: ymd(sd.date), engine: "enforced",
      text: `${sd.name}: ${sd.mode === "REPLACE" ? "only the listed shifts run" : "normal shifts with changes"} (${sd.shifts.length} line(s))` });
  }
  const templates = [...Object.values(tmpl), ...dated];

  // ---------------- participants: who is here, for how many shifts, and when they are off ----------------
  const [asg, adj, off] = await Promise.all([
    db.assignment.findMany({ where: { programId: pid, startDate: { lte: end }, endDate: { gte: start } }, include: { institutions: true }, orderBy: { id: "asc" } }),
    db.shiftAdjustment.findMany({ where: { intervalId } }),
    db.timeOff.findMany({ where: { programId: pid, startDate: { lte: end }, endDate: { gte: start } }, orderBy: [{ startDate: "asc" }, { id: "asc" }] }),
  ]);
  const pending = off.filter((t) => t.status === "PENDING").length;
  if (pending) warn.push(`${pending} time-off request(s) are still pending and are NOT included.`);
  const residents: Any[] = [];
  for (const p of peopleList) {
    const mine = asg.filter((a) => a.participantId === p.id);
    if (!mine.length) continue;
    const here = new Set<number>(), sites = new Set<string>(), extra: Any[] = [], shares: Record<string, number> = {}, notes: string[] = [];
    let lo = 0, hi = 0, noNights = false;
    const role = roles[p.roleId];
    for (const a of mine) {
      const days = eachDay(a.startDate, a.endDate).filter(inside);
      days.forEach((d) => here.add(idx(d)));
      const share = days.length / (dayDiff(a.startDate, a.endDate) + 1);
      if (share < 1) warn.push(`${pname(p.id)}: assignment ${ymd(a.startDate)} to ${ymd(a.endDate)} only partly overlaps the interval; its shift count is pro-rated to ${Math.round(share * 100)}%.`);
      // shift counts come from the role (an older assignment may still carry its own)
      const aMin = a.minShifts ?? role.defaultMinShifts, aMax = a.maxShifts ?? role.defaultMaxShifts;
      if (aMin == null || aMax == null) warn.push(`${pname(p.id)}: the role ${role.name} has no default number of shifts, so 0 is used. Set it under Roles.`);
      lo += Math.round((aMin ?? 0) * share); hi += Math.round((aMax ?? aMin ?? 0) * share);
      (a.institutions.length ? a.institutions.map((i) => i.institutionId) : instList.map((i) => i.id)).forEach((i) => sites.add(i));
      if (a.institutions.length > 1 && a.institutions.every((i) => i.sharePercent != null))
        for (const i of a.institutions) shares[site(i.institutionId)] = i.sharePercent!;
      for (const i of a.institutions) {              // only at this institution from / until these dates
        const code = site(i.institutionId);
        if (i.startDate && i.startDate > start) extra.push({ label: `not at ${code} before ${ymd(i.startDate)}`, sites: [code], to_day: idx(i.startDate) - 1 });
        if (i.endDate && i.endDate < end) extra.push({ label: `not at ${code} after ${ymd(i.endDate)}`, sites: [code], from_day: idx(i.endDate) + 1 });
      }
      noNights ||= a.noNights;
      if (a.notes) notes.push(a.notes);
    }
    const mineAdj = adj.filter((x) => x.participantId === p.id);
    const delta = mineAdj.reduce((a, x) => a + x.delta, 0);
    const caps = live.filter((r) => r.template === "max_shifts_per_interval" && (r.scope === "PROGRAM" || r.roleId === p.roleId || r.participantId === p.id)).map((r) => r.params.n);
    hi = Math.max(0, Math.min(hi + delta, ...caps)); lo = Math.max(0, Math.min(lo + delta, hi));
    const level = roles[p.roleId].level;
    // the role grid, sent explicitly for every person and every shift (inactive ones too: a special day can copy one).
    // The engine treats it as a hard rule; min_pgy is only a summary used by its capacity pre-check.
    // ... and only at the institutions this person is assigned to for the interval (by id, so short codes cannot blur it)
    const allowed = shiftsAll.filter((s) => isElig(s.id, p.roleId) && sites.has(s.institutionId)).map((s) => s.id);
    const res: Any = {
      id: p.id, name: pname(p.id), pgy: level, shifts_min: lo, shifts_max: hi, sites: [...sites].map((i) => site(i)).sort(),
      vacation: [] as number[], mandatory_off: Array.from({ length: n }, (_, i) => i).filter((i) => !here.has(i)), requests_off: {} as Record<string, number>, unavailable: [...extra] as Any[],
    };
    if (Object.keys(shares).length) res.site_share = shares;
    if (noNights) res.unavailable.push({ label: "no nights", categories: catList.filter((c) => c.isNight).map((c) => cat(c.id)) });
    res.only_shifts = [...allowed].sort();
    const runCaps = live.filter((r) => r.template === "max_days_in_a_row" && (r.roleId === p.roleId && r.scope === "ROLE" || r.participantId === p.id && r.scope === "PARTICIPANT")).map((r) => r.params.n);
    if (runCaps.length && Math.min(...runCaps) < cfgRules.max_consecutive_days) res.max_consecutive_days = Math.min(...runCaps);
    compiled.push({ origin: "Assignment", id: mine[0].id, template: "shift_count", scope: "PARTICIPANT", appliesTo: res.name, level: "HARD", engine: "enforced",
      text: `${lo}-${hi} shifts at ${res.sites.join(", ")}` + (delta ? ` (adjusted ${delta > 0 ? "+" : ""}${delta}: ${mineAdj.map((x) => x.reason || "no reason given").join("; ")})` : "")
        + (here.size < n ? `; present ${here.size} of ${n} days` : "") + (extra.length ? `; ${extra.map((u) => u.label).join("; ")}` : ""), note: notes.join(" ") || undefined });
    if (res.site_share) compiled.push({ origin: "Assignment", id: mine[0].id, template: "site_split", scope: "PARTICIPANT", appliesTo: res.name, level: "SOFT", engine: "enforced",
      text: `Split between institutions: ${Object.entries(shares).map(([k, v]) => `${v}% ${k}`).join(", ")} (within 1 shift)` });
    if (noNights) compiled.push({ origin: "Assignment", id: mine[0].id, template: "unavailable", scope: "PARTICIPANT", appliesTo: res.name, level: "HARD", engine: "enforced", text: "No night shifts", note: notes.join(" ") || undefined });
    for (const t of off.filter((t) => t.participantId === p.id)) {
      const days = eachDay(t.startDate, t.endDate).filter(inside).map(idx);
      const kind = ({ VACATION: "Vacation", REQUEST_OFF: "Request off", FIRST_DAY_OFF: "First day off", LAST_DAY_OFF: "Last day off", REQUIRED_OFF: "Required time off" } as Any)[t.kind];
      const window = t.startMinute != null && t.endMinute != null ? `, ${hhmm(t.startMinute)}-${hhmm(t.endMinute)}` : "";
      const entry = { origin: kind, id: t.id, template: "unavailable", scope: "PARTICIPANT", appliesTo: res.name, from: ymd(t.startDate), to: ymd(t.endDate),
        text: `Off ${ymd(t.startDate)} to ${ymd(t.endDate)}${window}` + (t.reason ? ` (${t.reason})` : "") };
      if (t.status !== "APPROVED") { compiled.push({ ...entry, level: "-", engine: `not included (${t.status.toLowerCase()})` }); continue; }
      if (t.kind === "VACATION") { res.vacation.push(...days); compiled.push({ ...entry, level: "HARD", engine: "enforced" }); }
      else if (t.kind === "REQUIRED_OFF" && window) {        // a time window on each of those days
        const hours = (((t.endMinute! - t.startMinute!) % 1440) + 1440) % 1440 / 60 || 24;
        res.unavailable.push({ label: t.reason || "required time off", from_day: Math.max(0, idx(t.startDate)), to_day: Math.min(n - 1, idx(t.endDate)), start: hhmm(t.startMinute!), hours });
        compiled.push({ ...entry, level: "HARD", engine: "enforced" });
      }
      else if (t.mandatory) { res.mandatory_off = [...new Set([...res.mandatory_off, ...days])].sort((a: number, b: number) => a - b); compiled.push({ ...entry, level: "HARD", engine: "enforced" }); }
      else {
        const w = WEIGHT[t.priority ?? "LOW"];
        for (const d of days) res.requests_off[String(d)] = Math.max(w, res.requests_off[String(d)] ?? 0);
        compiled.push({ ...entry, level: "SOFT", weight: w, priority: REQUESTS_PRIORITY, engine: "enforced" });
      }
    }
    for (const r of live) {
      if (r.template !== "unavailable" || !(r.scope === "PROGRAM" || r.roleId === p.roleId || r.participantId === p.id)) continue;
      const q = r.params, u: Any = { label: r.notes || "unavailable (rule)" };
      if (r.activeFrom) u.from_day = idx(r.activeFrom);
      if (r.activeTo) u.to_day = idx(r.activeTo);
      if (q.weekdays !== undefined && q.weekdays !== null) u.weekdays = q.weekdays;
      if (q.start) { u.start = q.start; u.hours = q.hours; }
      if (q.category_ids?.length) u.categories = q.category_ids.map((c: string) => (cats[c] ? cat(c) : c));
      if (q.institution_ids?.length) u.sites = q.institution_ids.map((i: string) => (insts[i] ? site(i) : i));
      res.unavailable.push(u);
    }
    res.vacation = [...new Set<number>(res.vacation)].sort((a, b) => a - b);
    residents.push(res);
  }

  // ---------------- academic time: the recurring series expanded to dated sessions ----------------
  const sessions = await academicSessions(pid, addDays(start, -7), end);
  const academic = sessions.map((s) => ({
    name: s.name, day: idx(s.date), start: hhmm(s.startMinute), hours: s.durationMinutes / 60, if_shift_overlaps: s.policy.toLowerCase(),
    protect_before_hours: s.protectBefore / 60, protect_after_hours: s.protectAfter / 60,
    ...(s.participantId
      ? { pgy: [-1], also_attend: [s.participantId], excused: [] }          // personal: only this participant, whatever their level
      : { excused: s.excused, also_attend: s.also, ...(s.roleIds.length ? { pgy: [...new Set(s.roleIds.map((r) => roles[r].level))].sort((a, b) => a - b) } : {}) }),
  }));
  const series = await db.academicDay.findMany({ where: { programId: pid, active: true, archivedAt: null }, include: { roles: true, _count: { select: { exceptions: true } } }, orderBy: { id: "asc" } });
  for (const a of series) {
    const count = sessions.filter((s) => s.academicDayId === a.id && s.date >= start).length;
    if (a.participantId && !count) continue;
    compiled.push({ origin: a.participantId ? "Personal academic day" : "Academic day", id: a.id, template: "academic_time", scope: a.participantId ? "PARTICIPANT" : a.roles.length ? "ROLE" : "PROGRAM", level: "HARD", engine: "enforced",
      appliesTo: a.participantId ? pname(a.participantId) : a.roles.map((r) => roles[r.roleId].name).join(", ") || "Everyone",
      text: `${a.name}: ${count} session(s) in the interval; overlapping shifts are ${a.overlapPolicy.toLowerCase()}` + (a._count.exceptions ? `; ${a._count.exceptions} personal exception(s)` : "") });
  }

  // ---------------- boundary: the last week of the previous published schedule ----------------
  const history: Any[] = [];
  const prev = await db.schedule.findFirst({ where: { status: "PUBLISHED", interval: { programId: pid, endDate: { lt: start } } }, orderBy: { interval: { endDate: "desc" } } });
  if (prev) {
    const ids = new Set(residents.map((r) => r.id));
    const rows = await db.scheduledShift.findMany({ where: { scheduleId: prev.id, participantId: { not: null }, backup: false, dutyDate: { gte: addDays(start, -7) } }, orderBy: { startsAt: "asc" } });   // on-call days were not worked
    for (const h of rows) {
      if (!ids.has(h.participantId!)) continue;
      const day0 = new Date(Date.UTC(h.startsAt.getUTCFullYear(), h.startsAt.getUTCMonth(), h.startsAt.getUTCDate()));
      history.push({ resident: h.participantId, day: idx(day0), start: h.startsAt.toISOString().slice(11, 16), hours: (h.endsAt.getTime() - h.startsAt.getTime()) / 3600000,
        category: cat(h.categoryId), name: h.name, counts_as_previous_day: h.dutyDate < day0 });
    }
  } else {
    const entered = await db.priorShift.findMany({ where: { intervalId }, orderBy: [{ date: "asc" }, { startMinute: "asc" }] });
    const ids = new Set(residents.map((r) => r.id));
    let notHere = 0;
    for (const h of entered) {
      if (idx(h.date) < -7 || idx(h.date) >= 0) continue;
      if (!ids.has(h.participantId)) { notHere++; continue; }
      history.push({ resident: h.participantId, day: idx(h.date), start: hhmm(h.startMinute), hours: h.durationMinutes / 60, category: cat(h.categoryId), name: h.name });
    }
    if (entered.length) compiled.push({ origin: "Previous interval", id: intervalId, template: "history", scope: "PROGRAM", appliesTo: "Everyone", level: "HARD", engine: "enforced",
      text: `${history.length} shift(s) entered by hand for the 7 days before the interval` });
    if (notHere) warn.push(`${notHere} shift(s) entered for the previous interval belong to people not assigned to this interval, so they are ignored.`);
    else warn.push("No published schedule for the previous interval: boundary rules start from a clean slate.");
  }

  // ---------------- backup (on-call) shifts ----------------
  const backup = backupList.map((b) => {
    const r = cleanBackupRules(b.backupRules);
    const eligible = residents.filter((x) => isElig(b.id, people[x.id].roleId)).map((x) => x.id);
    compiled.push({ origin: "Backup shift", id: b.id, template: "backup", scope: "INSTITUTION", appliesTo: insts[b.institutionId].name, level: "HARD", engine: "enforced",
      text: `${b.name} every ${b.daysOfWeek.length === 7 ? "day" : "listed weekday"}, ${hhmm(b.startMinute)} for ${b.durationMinutes / 60}h, ${b.minParticipants} person: ${describeBackupRules(r)}; ${eligible.length} eligible`,
      note: r.not_understood ? `Not understood, not enforced: ${r.not_understood}` : undefined });
    if (r.not_understood) warn.push(`${b.name}: part of its rules could not be turned into rules and is not enforced: "${r.not_understood}"`);
    if (!eligible.length) warn.push(`${b.name}: nobody assigned to this interval is eligible for it. Tick roles in its eligibility grid.`);
    return { name: b.name, ref: b.id, site: site(b.institutionId), category: cat(b.categoryId), start: hhmm(b.startMinute), hours: b.durationMinutes / 60,
      weekdays: [...b.daysOfWeek], headcount: b.minParticipants, eligible, rules: { max_per_person: r.max_per_person, min_days_between: r.min_days_between,
        rest_before_hours: r.rest_before_hours, rest_after_hours: r.rest_after_hours, min_per_person: r.min_per_person,
        not_after_night: r.not_after_night, not_before_night: r.not_before_night, not_next_to_vacation: r.not_next_to_vacation } };
  });

  const config = {
    name: `${iv.name} (${ymd(start)} to ${ymd(end)})`, start_date: ymd(start), n_days: n,
    category_order: catList.map((c) => cat(c.id)), night_categories: catList.filter((c) => c.isNight).map((c) => cat(c.id)),
    balance_groups: Object.fromEntries(catList.map((c) => [cat(c.id), c.balanceGroup || cat(c.id)])),
    pod_pairs: podPairs, rules: cfgRules, shift_templates: templates, academic_time: academic, residents, history,
    ...(backup.length ? { backup } : {}),
  };
  return { interval: iv, config, compiledRules: compiled, warnings: warn, sessions };
}
