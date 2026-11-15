// The rule template library (rule-templates.json) and everything derived from it:
// parameter validation, the plain-English sentence, and whether the engine enforces a rule.
import Ajv2020 from "ajv/dist/2020";
import lib from "./rule-templates.json";
import { DOW } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export type Template = {
  key: string; group: string; label: string; sentence: string; scopes: string[]; levels: string[];
  solver: "enforced" | "stored"; enforcedScopes?: string[]; solverNote?: string; params: Any;
};
export const TEMPLATES = lib.templates as Template[];
export const TEMPLATE: Record<string, Template> = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
export const SYSTEM_RULES = lib.systemRules as { template: string; level: "HARD" | "SOFT"; params: Any; weight?: number; priority?: number }[];
export const REQUESTS_PRIORITY = lib.builtInPriorities.requests_off;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = Object.fromEntries(TEMPLATES.map((t) => [t.key, ajv.compile(t.params)]));

export function paramErrors(template: string, params: Any): string | null {
  const v = validators[template];
  if (!v) return "Unknown template";
  return v(params) ? null : (v.errors ?? []).map((e) => `${e.instancePath.replace(/^\//, "") || "parameters"} ${e.message}`).join("; ");
}

export type EngineStatus = "enforced" | "stored only" | "needs review";
export function engineStatus(r: { template: string; scope: string; level: string; needsReview: boolean; params: Any }): { status: EngineStatus; note: string | null } {
  const t = TEMPLATE[r.template];
  if (!t) return { status: "needs review", note: "unknown template" };
  if (paramErrors(r.template, r.params)) return { status: "needs review", note: "invalid parameters" };
  if (r.template === "custom" || r.needsReview) return { status: "needs review", note: t.solverNote ?? null };
  let enforced = t.solver === "enforced" && (t.enforcedScopes ?? []).includes(r.scope);
  if ((r.template === "unavailable" || r.template === "min_hours_off_between_shifts") && r.level !== "HARD") enforced = false;
  return enforced ? { status: "enforced", note: null } : { status: "stored only", note: t.solverNote ?? null };
}

/** names: id -> display name for anything a parameter can point at (categories, institutions, areas, roles, people, shifts). */
export function ruleText(template: string, params: Any, names: Record<string, string>): string {
  const t = TEMPLATE[template];
  if (!t) return template;
  const look = (v: Any): Any => (Array.isArray(v) ? v.map(look) : typeof v === "string" ? names[v] ?? v : v);
  if (template === "unavailable") {
    const parts: string[] = [];
    if (params.category_ids?.length) parts.push(params.category_ids.map(look).join("/") + " shifts");
    if (params.institution_ids?.length) parts.push("at " + params.institution_ids.map(look).join(", "));
    if (params.weekdays) parts.push("on " + params.weekdays.map((d: number) => DOW[d]).join(", "));
    if (params.start) parts.push(`from ${params.start} for ${+params.hours}h`);
    return "Cannot work " + (parts.length ? parts.join(" ") : "at all");
  }
  return t.sentence.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === "together") return params.together ? "Must" : "Must not";
    const v = params[k];
    return v === undefined || v === null ? "?" : String(look(v));
  });
}
