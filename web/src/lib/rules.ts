// Server-side helpers for the Rules screens: choices, validation, display names.
import { db } from "./db";
import { TEMPLATE, paramErrors } from "./rule-templates";
import type { RuleDraft, RuleRefs } from "./rule-types";
import { parseYmd, shiftTimes, ymd } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export async function ruleRefs(programId: string): Promise<{ refs: RuleRefs; names: Record<string, string> }> {
  const [inst, roles, people, areas, cats, shifts] = await Promise.all([
    db.institution.findMany({ where: { programId, archivedAt: null }, orderBy: { name: "asc" } }),
    db.role.findMany({ where: { programId, archivedAt: null }, orderBy: { level: "asc" } }),
    db.participant.findMany({ where: { programId, archivedAt: null }, include: { role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
    db.area.findMany({ where: { institution: { programId } }, include: { institution: true }, orderBy: [{ institutionId: "asc" }, { name: "asc" }] }),
    db.shiftCategory.findMany({ where: { programId }, orderBy: { sortOrder: "asc" } }),
    db.shift.findMany({ where: { programId, archivedAt: null }, include: { institution: true }, orderBy: [{ institutionId: "asc" }, { startMinute: "asc" }] }),
  ]);
  const refs: RuleRefs = {
    Institution: inst.map((i) => ({ value: i.id, label: `${i.shortCode} · ${i.name}` })),
    Role: roles.map((r) => ({ value: r.id, label: r.name })),
    Participant: people.map((p) => ({ value: p.id, label: `${p.lastName}, ${p.firstName} (${p.role.name})` })),
    Area: areas.map((a) => ({ value: a.id, label: `${a.institution.shortCode} · ${a.name}` })),
    ShiftCategory: cats.map((c) => ({ value: c.id, label: c.name })),
    Shift: shifts.map((s) => ({ value: s.id, label: `${s.institution.shortCode} · ${s.name} (${shiftTimes(s.startMinute, s.durationMinutes)})` })),
  };
  const names: Record<string, string> = {
    ...Object.fromEntries(inst.map((i) => [i.id, i.name])), ...Object.fromEntries(roles.map((r) => [r.id, r.name])),
    ...Object.fromEntries(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`])), ...Object.fromEntries(areas.map((a) => [a.id, a.name])),
    ...Object.fromEntries(cats.map((c) => [c.id, c.name])), ...Object.fromEntries(shifts.map((s) => [s.id, s.name])),
  };
  return { refs, names };
}

/** Typed values out of whatever the form sent: numbers as numbers, blanks dropped. */
export function cleanParams(template: string, raw: Record<string, Any>): Record<string, Any> {
  const props = TEMPLATE[template]?.params?.properties ?? {};
  const out: Record<string, Any> = {};
  for (const [k, schema] of Object.entries<Any>(props)) {
    const v = raw?.[k];
    if (schema.type === "boolean") { out[k] = v === true || v === "true"; continue; }
    if (v === undefined || v === null || v === "") continue;
    if (schema.type === "array") { if (Array.isArray(v) && v.length) out[k] = schema.items?.type === "integer" ? v.map(Number).sort((a: number, b: number) => a - b) : v.map(String); continue; }
    out[k] = schema.type === "integer" || schema.type === "number" ? Number(v) : String(v);
  }
  return out;
}

export function rowToDraft(r: Any): RuleDraft {
  return {
    scope: r.scope, institutionId: r.institutionId ?? "", roleId: r.roleId ?? "", participantId: r.participantId ?? "", template: r.template, params: r.params ?? {},
    level: r.level, weight: r.weight == null ? "5" : String(r.weight), priority: r.priority == null ? "9" : String(r.priority),
    activeFrom: ymd(r.activeFrom), activeTo: ymd(r.activeTo), notes: r.notes ?? "", enabled: r.enabled, needsReview: r.needsReview,
    originalText: r.originalText ?? "", source: r.source,
  };
}

export async function validateDraft(d: RuleDraft, programId: string) {
  const errors: Record<string, string> = {};
  const t = TEMPLATE[d.template];
  if (!t) return { errors: { template: "Choose a rule template" }, data: null };
  if (!t.scopes.includes(d.scope)) errors.scope = `"${t.label}" can be set for: ${t.scopes.map((s) => s.toLowerCase()).join(", ")}`;
  if (!t.levels.includes(d.level)) errors.level = `"${t.label}" can only be ${t.levels.map((l) => l.toLowerCase()).join(" or ")}`;
  const { refs } = await ruleRefs(programId);
  const has = (ref: keyof RuleRefs, id: string) => refs[ref].some((o) => o.value === id);
  const target = { PROGRAM: null, INSTITUTION: ["institutionId", "Institution"], ROLE: ["roleId", "Role"], PARTICIPANT: ["participantId", "Participant"] }[d.scope] as [keyof RuleDraft, keyof RuleRefs] | null;
  if (target && !has(target[1], d[target[0]] as string)) errors[target[0]] = `Choose the ${d.scope.toLowerCase()} this rule applies to`;
  const params = cleanParams(d.template, d.params);
  const bad = paramErrors(d.template, params);
  if (bad) {
    const props = Object.keys(t.params.properties ?? {});
    const field = props.find((p) => bad.includes(p) || bad.includes(`'${p}'`));
    errors[field ? `params.${field}` : "params"] = field ? "Required, or not in the allowed range" : bad;
    if (!field) errors.params = bad;
  }
  for (const [k, schema] of Object.entries<Any>(t.params.properties ?? {})) {
    const ref = schema["x-ref"] ?? schema.items?.["x-ref"];
    if (!ref || params[k] === undefined) continue;
    for (const id of Array.isArray(params[k]) ? params[k] : [params[k]]) if (!has(ref, id)) errors[`params.${k}`] = "That choice no longer exists";
  }
  if (d.template === "work_with" && d.scope === "PARTICIPANT" && params.participant_id === d.participantId) errors["params.participant_id"] = "Choose a different person";
  if (d.template === "balance_areas" && params.area_a && params.area_a === params.area_b) errors["params.area_b"] = "Choose two different areas";
  if (d.template === "weekends_per_interval" && params.max < params.min) errors["params.max"] = "Must be at least the minimum";
  if (d.template === "unavailable" && !Object.keys(params).length && !d.activeFrom && !d.activeTo) errors.params = "Say what they cannot work: pick days, a time window, shift types or places, or set active dates.";
  const from = d.activeFrom ? parseYmd(d.activeFrom) : null, to = d.activeTo ? parseYmd(d.activeTo) : null;
  if (from && to && to < from) errors.activeTo = "Must be on or after the first date";
  let weight: number | null = null, priority: number | null = null;
  if (d.level === "SOFT") {
    weight = Number(d.weight); priority = d.priority === "" ? null : Number(d.priority);
    if (!Number.isInteger(weight) || weight < 1 || weight > 10) errors.weight = "Weight is a whole number from 1 to 10";
    if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 99)) errors.priority = "Priority is a whole number, 1 = first";
  }
  const data = {
    scope: d.scope, institutionId: d.scope === "INSTITUTION" ? d.institutionId : null, roleId: d.scope === "ROLE" ? d.roleId : null,
    participantId: d.scope === "PARTICIPANT" ? d.participantId : null, template: d.template, params, level: d.level, weight, priority,
    activeFrom: from, activeTo: to, notes: d.notes.trim() || null, enabled: d.enabled, needsReview: d.template === "custom" ? true : d.needsReview,
  };
  return { errors, data };
}
