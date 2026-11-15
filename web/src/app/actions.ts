"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { endSession, requireAdmin, requireSession } from "@/lib/auth";
import { ENTITIES } from "@/lib/entities";
import { friendlyDbError, parseForm, toData, type FormState, type Row } from "@/lib/crud";
import { dow, DOW, parseYmd, toMinutes } from "@/lib/util";
import { validateDraft } from "@/lib/rules";
import type { RuleDraft, RuleFormState } from "@/lib/rule-types";
import { getRuleInterpreter, type Proposal } from "@/lib/rule-interpreter";
import { BUDGETS, cancelRun, startRun, type Budget } from "@/lib/engine";
import { publish, unpublish } from "@/lib/schedules";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = (name: string) => (db as any)[name];
const isFk = (e: unknown) => (e as { code?: string })?.code === "P2003" || /foreign key|violates RESTRICT/i.test(String((e as Error)?.message));
const back = (path: string, kind: "notice" | "error", text: string): never => redirect(`${path}?${kind}=${encodeURIComponent(text)}`);
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string) => (str(fd, k) === "" ? null : Number(str(fd, k)));
const mins = (fd: FormData, k: string) => (str(fd, k) ? toMinutes(str(fd, k)) : null);
const hours = (fd: FormData, k: string) => (str(fd, k) === "" ? null : Math.round(Number(str(fd, k)) * 60));

// ───────────────────────────── sign out (signing in is in account-actions.ts) ─────────────────────────────
export async function signOut() {
  await endSession();
  redirect("/login");
}

// ───────────────────────────── generic create / update / delete ─────────────────────────────
export async function saveEntity(slug: string, id: string | null, _prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireAdmin();
  const e = ENTITIES[slug];
  if (!e) return { message: "Unknown screen" };
  const ctx = { programId: s.programId, userId: s.userId };
  const { values, errors, raw } = parseForm(e.fields, fd);
  if (!Object.keys(errors).length) {
    await e.prepare?.(values, ctx, id);
    Object.assign(errors, (await e.validate?.(values, ctx, id))?.errors ?? {});
  }
  if (Object.keys(errors).length) return { errors, values: raw, message: "Not saved. Please fix the highlighted fields.", at: Date.now() };
  try {
    if (id) {
      if (!(await model(e.model).findFirst({ where: { id, programId: s.programId } }))) return { message: "Not found" };
      await model(e.model).update({ where: { id }, data: toData(e.fields, values, true) });
    } else {
      await model(e.model).create({
        data: { ...toData(e.fields, values, false), ...e.fixed, programId: s.programId, ...(e.stamp ? { createdById: s.userId } : {}),
          // the secret in a participant's personal calendar link: 192 random bits, not a guessable id
          ...(slug === "participants" ? { calendarToken: randomBytes(24).toString("base64url") } : {}) },
      });
    }
  } catch (err) {
    return { message: friendlyDbError(err), values: raw, at: Date.now() };
  }
  revalidatePath("/", "layout");
  redirect(`/${slug}?notice=${encodeURIComponent(`${e.singular.charAt(0).toUpperCase() + e.singular.slice(1)} saved.`)}`);
}

/** Delete; if anything still references the row, archive it instead (when the table can be archived). */
export async function removeEntity(slug: string, id: string) {
  const s = await requireAdmin();
  const e = ENTITIES[slug];
  if (!(await model(e.model).findFirst({ where: { id, programId: s.programId } }))) back(`/${slug}`, "error", "Not found");
  let note = `Deleted the ${e.singular}.`;
  let kind: "notice" | "error" = "notice";
  try {
    await model(e.model).delete({ where: { id } });
  } catch (err) {
    if (isFk(err) && e.archivable) {
      await model(e.model).update({ where: { id }, data: { archivedAt: new Date(), ...(e.hasActive ? { active: false } : {}) } });
      note = `That ${e.singular} is used elsewhere, so it was archived instead of deleted.`;
    } else {
      kind = "error";
      note = friendlyDbError(err);
    }
  }
  revalidatePath("/", "layout");
  back(`/${slug}`, kind, note);
}
export async function restoreEntity(slug: string, id: string) {
  const s = await requireAdmin();
  const e = ENTITIES[slug];
  await model(e.model).updateMany({ where: { id, programId: s.programId }, data: { archivedAt: null, ...(e.hasActive ? { active: true } : {}) } });
  revalidatePath("/", "layout");
  back(`/${slug}/${id}`, "notice", "Restored.");
}

// ───────────────────────────── child rows on the setup screens ─────────────────────────────
export async function addArea(institutionId: string, fd: FormData) {
  const s = await requireAdmin();
  const path = `/institutions/${institutionId}`;
  if (!(await db.institution.findFirst({ where: { id: institutionId, programId: s.programId } }))) back(path, "error", "Not found");
  if (!str(fd, "name") || !str(fd, "shortCode")) back(path, "error", "An area needs a name and a short code.");
  try {
    await db.area.create({ data: { institutionId, name: str(fd, "name"), shortCode: str(fd, "shortCode") } });
  } catch (e) { back(path, "error", friendlyDbError(e)); }
  back(path, "notice", "Area added.");
}
export async function deleteArea(id: string) {
  const s = await requireAdmin();
  const a = await db.area.findFirst({ where: { id, institution: { programId: s.programId } } });
  if (!a) redirect("/institutions");
  try { await db.area.delete({ where: { id } }); } catch (e) { back(`/institutions/${a.institutionId}`, "error", friendlyDbError(e)); }
  back(`/institutions/${a.institutionId}`, "notice", "Area deleted.");
}

/** The shift x role grid, edited from either side. */
export async function saveEligibility(side: "shift" | "role", id: string, fd: FormData) {
  const s = await requireAdmin();
  const [shifts, roles] = await Promise.all([
    db.shift.findMany({ where: { programId: s.programId } }), db.role.findMany({ where: { programId: s.programId } })]);
  const pairs = side === "shift" ? roles.map((r) => ({ shiftId: id, roleId: r.id, key: r.id })) : shifts.map((x) => ({ shiftId: x.id, roleId: id, key: x.id }));
  for (const p of pairs) {
    const eligible = fd.get(`elig_${p.key}`) === "on";
    const req = side === "shift" ? Math.max(0, num(fd, `req_${p.key}`) ?? 0) : undefined;
    await db.shiftRole.upsert({
      where: { shiftId_roleId: { shiftId: p.shiftId, roleId: p.roleId } },
      create: { shiftId: p.shiftId, roleId: p.roleId, eligible, requiredCount: eligible ? req ?? 0 : 0 },
      update: { eligible, ...(eligible ? (req === undefined ? {} : { requiredCount: req }) : { requiredCount: 0 }) },
    });
  }
  revalidatePath("/", "layout");
  back(`/${side === "shift" ? "shifts" : "roles"}/${id}`, "notice", "Eligibility saved.");
}

export async function addSpecialLine(dayId: string, fd: FormData) {
  const s = await requireAdmin();
  const path = `/special-days/${dayId}`;
  if (!(await db.specialStaffingDay.findFirst({ where: { id: dayId, programId: s.programId } }))) back(path, "error", "Not found");
  const action = str(fd, "action") as "ADD" | "CHANGE" | "REMOVE";
  const shiftId = str(fd, "shiftId") || null;
  const d = {
    name: str(fd, "name") || null, categoryId: str(fd, "categoryId") || null, startMinute: mins(fd, "start"),
    durationMinutes: hours(fd, "hours"), minParticipants: num(fd, "min"), maxParticipants: num(fd, "max"),
  };
  if (action !== "ADD" && !shiftId) back(path, "error", "Choose which normal shift to change or remove.");
  if (action === "ADD" && !shiftId && !(d.name && d.categoryId && d.startMinute != null && d.durationMinutes))
    back(path, "error", "A brand-new shift needs a name, category, start time and length (or pick a normal shift to copy).");
  if (d.minParticipants != null && d.maxParticipants != null && d.maxParticipants < d.minParticipants) back(path, "error", "Max headcount must be at least the minimum.");
  try {
    await db.specialStaffingShift.create({ data: { specialStaffingDayId: dayId, action, shiftId, ...(action === "REMOVE" ? {} : d) } });
  } catch (e) { back(path, "error", friendlyDbError(e)); }
  back(path, "notice", "Line added.");
}
export async function deleteSpecialLine(id: string) {
  const s = await requireAdmin();
  const l = await db.specialStaffingShift.findFirst({ where: { id, day: { programId: s.programId } } });
  if (!l) redirect("/special-days");
  try { await db.specialStaffingShift.delete({ where: { id } }); } catch (e) { back(`/special-days/${l.specialStaffingDayId}`, "error", friendlyDbError(e)); }
  back(`/special-days/${l.specialStaffingDayId}`, "notice", "Line removed.");
}

export async function addOccurrence(academicDayId: string, fd: FormData) {
  const s = await requireAdmin();
  const path = `/academic-days/${academicDayId}`;
  const a = await db.academicDay.findFirst({ where: { id: academicDayId, programId: s.programId } });
  if (!a) redirect("/academic-days");
  if (!str(fd, "date")) back(path, "error", "Pick the date of the session that differs.");
  const date = parseYmd(str(fd, "date"));
  if (dow(date) !== a.dayOfWeek) back(path, "error", `That date is a ${DOW[dow(date)]}; this series runs on ${DOW[a.dayOfWeek]}s.`);
  try {
    await db.academicDayOccurrence.create({
      data: { academicDayId, date, cancelled: fd.get("cancelled") === "on", startMinute: mins(fd, "start"), durationMinutes: hours(fd, "hours"),
        overlapPolicy: (str(fd, "policy") || null) as "BLOCKED" | "EXCUSED" | null },
    });
  } catch (e) { back(path, "error", friendlyDbError(e)); }
  back(path, "notice", "Change saved for that week.");
}
export async function addException(academicDayId: string, fd: FormData) {
  const s = await requireAdmin();
  const path = `/academic-days/${academicDayId}`;
  if (!(await db.academicDay.findFirst({ where: { id: academicDayId, programId: s.programId } }))) redirect("/academic-days");
  if (!str(fd, "participantId")) back(path, "error", "Choose a participant.");
  const a = str(fd, "startDate") ? parseYmd(str(fd, "startDate")) : null;
  const b = str(fd, "endDate") ? parseYmd(str(fd, "endDate")) : a;
  if (a && b && b < a) back(path, "error", "The last date must be on or after the first.");
  await db.academicDayException.create({
    data: { academicDayId, participantId: str(fd, "participantId"), type: str(fd, "type") as "EXCUSED" | "REQUIRED", startDate: a, endDate: b, reason: str(fd, "reason") || null },
  });
  back(path, "notice", "Exception added.");
}
export async function deleteAcademicChild(kind: "occurrence" | "exception", id: string) {
  const s = await requireAdmin();
  const row: Row = kind === "occurrence"
    ? await db.academicDayOccurrence.findFirst({ where: { id, academicDay: { programId: s.programId } } })
    : await db.academicDayException.findFirst({ where: { id, academicDay: { programId: s.programId } } });
  if (!row) redirect("/academic-days");
  if (kind === "occurrence") await db.academicDayOccurrence.delete({ where: { id } });
  else await db.academicDayException.delete({ where: { id } });
  back(`/academic-days/${row.academicDayId}`, "notice", "Removed.");
}

// ───────────────────────────── requests, intervals, settings ─────────────────────────────
export async function setRequestStatus(id: string, status: "APPROVED" | "DENIED" | "PENDING", returnTo: string) {
  const s = await requireAdmin();
  await db.timeOff.updateMany({ where: { id, programId: s.programId }, data: { status } });
  revalidatePath("/", "layout");
  redirect(/^\/(?!\/)/.test(returnTo) ? returnTo : "/requests");      // only ever back to a page of this app
}

/** Lock or unlock an interval's inputs. Publishing is done from a schedule (publishSchedule), never on its own. */
export async function setIntervalStatus(id: string, status: "DRAFT" | "LOCKED") {
  const s = await requireAdmin();
  const done = await db.interval.updateMany({
    where: { id, programId: s.programId, status: { not: "PUBLISHED" } },
    data: { status, lockedAt: status === "DRAFT" ? null : new Date(), publishedAt: null },
  });
  revalidatePath("/", "layout");
  if (!done.count) back(`/intervals/${id}`, "error", "This interval is published. Unpublish its schedule first.");
  back(`/intervals/${id}`, "notice", status === "LOCKED" ? "Inputs are locked." : "Inputs are unlocked.");
}
export async function setRequestsOpen(id: string, open: boolean) {
  const s = await requireAdmin();
  await db.interval.updateMany({ where: { id, programId: s.programId }, data: { requestsOpen: open } });
  revalidatePath("/", "layout");
  back(`/intervals/${id}`, "notice", open ? "Requests are open for this interval." : "Requests are closed for this interval.");
}

export async function saveSettings(fd: FormData) {
  const s = await requireAdmin();
  const days = num(fd, "defaultRequestAllowance"), high = num(fd, "defaultHighPriorityAllowance");
  if (!str(fd, "name") || days == null || high == null || days < 0 || high < 0) back("/settings", "error", "Enter a name and both allowances (0 or more).");
  await db.program.update({
    where: { id: s.programId },
    data: { name: str(fd, "name"), timezone: str(fd, "timezone"), defaultRequestAllowance: days!, defaultHighPriorityAllowance: high!,
      requestsRequireApproval: fd.get("requestsRequireApproval") === "on" },
  });
  revalidatePath("/", "layout");
  back("/settings", "notice", "Settings saved.");
}

// ───────────────────────────── rules ─────────────────────────────
export async function saveRule(id: string | null, _prev: RuleFormState, fd: FormData): Promise<RuleFormState> {
  const s = await requireAdmin();
  let draft: RuleDraft;
  try { draft = JSON.parse(String(fd.get("draft"))); } catch { return { message: "Could not read the form. Please try again." }; }
  const { errors, data } = await validateDraft(draft, s.programId);
  if (!data || Object.keys(errors).length) return { errors, draft, message: "Not saved. Please fix the highlighted fields." };
  try {
    if (id) {
      if (!(await db.rule.findFirst({ where: { id, programId: s.programId } }))) return { message: "Not found" };
      await db.rule.update({ where: { id }, data });
    } else {
      const fromText = draft.originalText.trim();
      await db.rule.create({ data: { ...data, programId: s.programId, createdById: s.userId, source: fromText ? "AI_ASSISTED" : "MANUAL", originalText: fromText || null } });
    }
  } catch (err) {
    return { message: friendlyDbError(err), draft };
  }
  revalidatePath("/", "layout");
  redirect(`/rules?notice=${encodeURIComponent("Rule saved.")}`);
}
export async function toggleRule(id: string, enabled: boolean) {
  const s = await requireAdmin();
  await db.rule.updateMany({ where: { id, programId: s.programId }, data: { enabled } });
  revalidatePath("/", "layout");
  back("/rules", "notice", enabled ? "Rule switched on." : "Rule switched off.");
}
/** System rules can be switched off or edited but not deleted. */
export async function removeRule(id: string) {
  const s = await requireAdmin();
  const r = await db.rule.findFirst({ where: { id, programId: s.programId } });
  if (!r) back("/rules", "error", "Not found");
  if (r!.source === "SYSTEM") back(`/rules/${id}`, "error", "System rules cannot be deleted. Switch it off instead.");
  await db.rule.delete({ where: { id } });
  revalidatePath("/", "layout");
  back("/rules", "notice", "Rule deleted.");
}
/** Plain English -> a proposed rule. Nothing is saved here. */
export async function interpretText(text: string): Promise<{ proposal: Proposal; interpreter: string } | { error: string }> {
  const s = await requireAdmin();
  if (text.trim().length < 5) return { error: "Type the restriction in a sentence first." };
  const [people, roles, inst, cats] = await Promise.all([
    db.participant.findMany({ where: { programId: s.programId, archivedAt: null } }), db.role.findMany({ where: { programId: s.programId, archivedAt: null } }),
    db.institution.findMany({ where: { programId: s.programId, archivedAt: null } }), db.shiftCategory.findMany({ where: { programId: s.programId } }),
  ]);
  const it = getRuleInterpreter();
  try {
    const proposal = await it.interpret(text, {
      today: new Date().toISOString().slice(0, 10),
      participants: people.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, lastName: p.lastName, roleId: p.roleId })),
      roles: roles.map((r) => ({ id: r.id, name: r.name })), institutions: inst.map((i) => ({ id: i.id, name: i.name, shortCode: i.shortCode })),
      categories: cats.map((c) => ({ id: c.id, name: c.name, isNight: c.isNight })),
    });
    return { proposal, interpreter: it.name };
  } catch (e) {
    return { error: "The interpreter failed: " + String((e as Error).message).slice(0, 200) };
  }
}

// ───────────────────────────── the resident's own requests ─────────────────────────────
const canSubmit = (iv: { requestsOpen: boolean; status: string; requestDeadline: Date | null }) =>
  iv.requestsOpen && iv.status === "DRAFT" && (!iv.requestDeadline || new Date() <= iv.requestDeadline);

export async function submitMyRequest(fd: FormData) {
  const s = await requireSession();
  if (!s.participantId) back("/me", "error", "This sign-in is not linked to a participant.");
  const intervalId = str(fd, "intervalId");
  const iv = await db.interval.findFirst({ where: { id: intervalId, programId: s.programId }, include: { program: true } });
  if (!iv) back("/me", "error", "Choose an interval.");
  if (!canSubmit(iv!)) back("/me", "error", `${iv!.name} is not accepting requests${iv!.requestDeadline && new Date() > iv!.requestDeadline ? " (the deadline has passed)" : ""}.`);
  if (!str(fd, "startDate")) back("/me", "error", "Pick the day you are asking for.");
  const start = parseYmd(str(fd, "startDate")), end = str(fd, "endDate") ? parseYmd(str(fd, "endDate")) : start;
  if (end < start) back("/me", "error", "The last day must be on or after the first.");
  if (start < iv!.startDate || end > iv!.endDate) back("/me", "error", `Those dates are outside ${iv!.name}.`);
  const priority = str(fd, "priority") as "HIGH" | "MEDIUM" | "LOW";
  if (!["HIGH", "MEDIUM", "LOW"].includes(priority)) back("/me", "error", "Choose a priority.");
  const mine = await db.timeOff.findMany({ where: { participantId: s.participantId!, status: { not: "DENIED" } } });
  if (mine.some((t) => t.startDate <= end && start <= t.endDate)) back("/me", "error", "You already have time off or a request covering some of those days.");
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const counted = mine.filter((t) => t.intervalId === intervalId && t.kind === "REQUEST_OFF");
  const used = counted.reduce((n, t) => n + Math.round((t.endDate.getTime() - t.startDate.getTime()) / 86400000) + 1, 0);
  const high = counted.filter((t) => t.priority === "HIGH").reduce((n, t) => n + Math.round((t.endDate.getTime() - t.startDate.getTime()) / 86400000) + 1, 0);
  const allow = iv!.requestAllowance ?? iv!.program.defaultRequestAllowance, allowHigh = iv!.highPriorityAllowance ?? iv!.program.defaultHighPriorityAllowance;
  if (used + days > allow) back("/me", "error", `That would be ${used + days} request days; the allowance for ${iv!.name} is ${allow}. Ask your chief or coordinator if you need an exception.`);
  if (priority === "HIGH" && high + days > allowHigh) back("/me", "error", `That would be ${high + days} high-priority days; the allowance is ${allowHigh}. Choose a lower priority.`);
  const pending = iv!.program.requestsRequireApproval;
  await db.timeOff.create({
    data: { programId: s.programId, participantId: s.participantId!, intervalId, kind: "REQUEST_OFF", startDate: start, endDate: end, priority,
      reason: str(fd, "reason") || null, status: pending ? "PENDING" : "APPROVED", createdById: s.userId },
  });
  revalidatePath("/", "layout");
  back("/me", "notice", pending ? "Request submitted. It counts once it has been approved." : "Request submitted.");
}
export async function withdrawMyRequest(id: string) {
  const s = await requireSession();
  const t = await db.timeOff.findFirst({ where: { id, participantId: s.participantId ?? "-", kind: "REQUEST_OFF" }, include: { interval: true } });
  if (!t) back("/me", "error", "Not found.");
  if (t!.interval && t!.interval.status !== "DRAFT") back("/me", "error", "That interval is locked; ask your chief or coordinator.");
  await db.timeOff.delete({ where: { id } });
  revalidatePath("/", "layout");
  back("/me", "notice", "Request withdrawn.");
}

// ───────────────────────────── schedules: generate, review, publish ─────────────────────────────
const go = (path: string, params: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(params)}`);
const audit = (s: { programId: string; userId: string }, entityId: string, action: string, changes?: object) =>
  db.auditLog.create({ data: { programId: s.programId, userId: s.userId, entity: "Schedule", entityId, action, changes } });
const mySchedule = (sid: string, programId: string) =>
  db.schedule.findFirst({ where: { id: sid, interval: { programId } }, include: { interval: true } });

export async function generateSchedule(intervalId: string, fd: FormData) {
  const s = await requireAdmin();
  const hub = `/intervals/${intervalId}`;
  if (!(await db.interval.findFirst({ where: { id: intervalId, programId: s.programId } }))) back("/intervals", "error", "That interval does not exist.");
  const key = str(fd, "budget");
  const r = await startRun(intervalId, s.userId, (key in BUDGETS ? key : "standard") as Budget);
  revalidatePath("/", "layout");
  if (!r.ok) return go(hub, { tab: "schedule", error: r.error });
  await audit(s, r.scheduleId, "generate", { budget: key || "standard" });
  go(hub, { tab: "schedule" });
}

export async function cancelSchedule(sid: string) {
  const s = await requireAdmin();
  const sch = await mySchedule(sid, s.programId);
  if (!sch) return back("/intervals", "error", "That schedule does not exist.");
  const stopped = await cancelRun(sid);
  if (stopped) await audit(s, sid, "cancel");
  revalidatePath("/", "layout");
  go(`/intervals/${sch.intervalId}`, { tab: "schedule", ...(stopped ? { notice: "The run was cancelled. Nothing was saved." } : { error: "That run had already finished." }) });
}

export async function publishSchedule(sid: string, fd: FormData) {
  const s = await requireAdmin();
  const sch = await mySchedule(sid, s.programId);
  if (!sch) return back("/intervals", "error", "That schedule does not exist.");
  const here = `/intervals/${sch.intervalId}/schedules/${sid}`;
  const r = await publish(sid, s.programId, fd.get("confirm") === "on");
  if (!r.ok) return back(here, "error", r.error);
  await audit(s, sid, "publish", { openShifts: r.open, inputsChanged: r.stale });
  revalidatePath("/", "layout");
  back(here, "notice", `${r.intervalName} is published. Participants can now see their shifts, and calendar links are updated.`);
}

export async function unpublishSchedule(intervalId: string, returnTo: string) {
  const s = await requireAdmin();
  if (!(await db.interval.findFirst({ where: { id: intervalId, programId: s.programId } }))) return back("/intervals", "error", "That interval does not exist.");
  const was = await unpublish(intervalId, s.programId);
  if (was) await audit(s, was, "unpublish");
  revalidatePath("/", "layout");
  back(returnTo.startsWith(`/intervals/${intervalId}`) ? returnTo : `/intervals/${intervalId}`, "notice", "Unpublished. Participants no longer see this schedule; it is kept as a draft.");
}

export async function discardSchedule(sid: string) {
  const s = await requireAdmin();
  const sch = await mySchedule(sid, s.programId);
  if (!sch) return back("/intervals", "error", "That schedule does not exist.");
  const hub = `/intervals/${sch.intervalId}`;
  if (sch.status === "PUBLISHED") return go(hub, { tab: "schedule", error: "A published schedule cannot be discarded. Unpublish it first." });
  await cancelRun(sid);
  await db.schedule.delete({ where: { id: sid } });
  await audit(s, sid, "discard", { label: sch.label });
  revalidatePath("/", "layout");
  go(hub, { tab: "schedule", notice: `${sch.label ?? "Schedule"} was discarded.` });
}
