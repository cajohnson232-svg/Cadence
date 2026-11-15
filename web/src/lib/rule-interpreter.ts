// "Other restrictions": plain English -> a PROPOSED structured rule.
//
// The language model sits behind the RuleInterpreter interface so the provider can be swapped.
// RULE_PARSER=mock (the default) uses the keyword-based stand-in below, which needs no network
// and no key. To add a real provider, implement RuleInterpreter and register it in PROVIDERS.
// Whatever the provider returns is only ever a proposal: the admin edits and confirms it.
import { TEMPLATE } from "./rule-templates";

export type Named = { id: string; name: string };
export type InterpreterContext = {
  today: string; // YYYY-MM-DD
  participants: (Named & { lastName: string; roleId: string })[];
  roles: Named[];
  institutions: (Named & { shortCode: string })[];
  categories: (Named & { isNight: boolean })[];
};
export type Proposal = {
  template: string;
  params: Record<string, unknown>;
  scope: "PROGRAM" | "INSTITUTION" | "ROLE" | "PARTICIPANT";
  institutionId: string | null;
  roleId: string | null;
  participantId: string | null;
  level: "HARD" | "SOFT";
  weight: number | null;
  activeFrom: string | null;
  activeTo: string | null;
  notes: string;
  needsReview: boolean; // true when the text could not be mapped to a template
  explanation: string[]; // how the text was read, shown next to the original
};
export interface RuleInterpreter {
  readonly name: string;
  interpret(text: string, ctx: InterpreterContext): Promise<Proposal>;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [RegExp, number[], string][] = [
  [/\bweekends?\b/, [5, 6], "weekends"], [/\bweekdays?\b/, [0, 1, 2, 3, 4], "weekdays"],
  [/\bmon(days?)?\b/, [0], "Mondays"], [/\btue(s|sdays?)?\b/, [1], "Tuesdays"], [/\bwed(nesdays?)?\b/, [2], "Wednesdays"], [/\bthu(r|rs|rsdays?)?\b/, [3], "Thursdays"],
  [/\bfri(days?)?\b/, [4], "Fridays"], [/\bsat(urdays?)?\b/, [5], "Saturdays"], [/\bsun(days?)?\b/, [6], "Sundays"],
];
const pad = (n: number) => String(n).padStart(2, "0");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Jan-Mar", "from Jan 10 to Jan 24", "until March 3", "in February" -> a date range in the coming year. */
function dateRange(t: string, today: string): { from: string | null; to: string | null; read: string } | null {
  const m = [...t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?(?:\s*(?:-|–|to|through|thru)\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:)))?/g)];
  if (!m.length) return null;
  const year0 = Number(today.slice(0, 4));
  const lastDay = (y: number, mo: number) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const a = m[0], b = m[1];
  const mo1 = MONTHS.indexOf(a[1]), mo2 = b ? MONTHS.indexOf(b[1]) : mo1;
  let y1 = year0;
  const endDay = (y: number) => (b ? (b[2] ? Number(b[2]) : lastDay(y, mo2)) : a[3] ? Number(a[3]) : a[2] ? Number(a[2]) : lastDay(y, mo2));
  let y2 = mo2 < mo1 ? y1 + 1 : y1;
  if (`${y2}-${pad(mo2 + 1)}-${pad(endDay(y2))}` < today) { y1 += 1; y2 += 1; } // already past: they mean next year
  const from = `${y1}-${pad(mo1 + 1)}-${pad(a[2] ? Number(a[2]) : 1)}`, to = `${y2}-${pad(mo2 + 1)}-${pad(endDay(y2))}`;
  const until = /\b(until|through|thru|till)\b/.test(t.slice(Math.max(0, a.index! - 12), a.index!)) && !b && !a[3];
  const starting = /\b(starting|from|after|beginning)\b/.test(t.slice(Math.max(0, a.index! - 12), a.index!)) && !b && !a[3];
  if (until) return { from: null, to, read: `until ${to}` };
  if (starting) return { from, to: null, read: `from ${from}` };
  return { from, to, read: `${from} to ${to}` };
}

export class MockRuleInterpreter implements RuleInterpreter {
  readonly name = "mock (keyword-based stand-in, development only)";

  async interpret(text: string, ctx: InterpreterContext): Promise<Proposal> {
    const t = " " + text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ") + " ";
    const why: string[] = [];
    const people = ctx.participants.filter((p) => new RegExp(`\\b${esc(p.lastName.toLowerCase())}\\b`).test(t))
      .sort((a, b) => t.indexOf(a.lastName.toLowerCase()) - t.indexOf(b.lastName.toLowerCase()));
    const role = ctx.roles.find((r) => new RegExp(`\\b${esc(r.name.toLowerCase()).replace(/[-\s]+/g, "[-\\s]?")}s?\\b`).test(t));
    const insts = ctx.institutions.filter((i) => new RegExp(`\\b(${esc(i.shortCode.toLowerCase())}|${esc(i.name.toLowerCase())}|${i.name.toLowerCase().split(/\s+/).filter((w) => w.length > 4 && w !== "hospital").map(esc).join("|") || "\\u0000"})\\b`).test(t));
    const cats = ctx.categories.filter((c) => (c.isNight && /\b(overnights?|nights?)\b/.test(t)) || new RegExp(`\\b${esc(c.name.toLowerCase())}s?( shifts?)?\\b`).test(t));
    const wd = [...new Set(DAYS.filter(([re]) => re.test(t)).flatMap(([, d]) => d))].sort();
    const dates = dateRange(t, ctx.today);
    const soft = /\b(prefer|prefers|try|ideally|if possible|when possible|avoid|would like|rather not|where possible|aim)\b/.test(t);
    const num = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[m.length - 1]) : null; };
    const cap = "(?:no more than|not more than|max(?:imum)?(?: of)?|at most|up to|limit(?:ed)? to)\\s+";

    let template = "custom";
    let params: Record<string, unknown> = { text: text.trim() };
    let other: string | null = null;
    const negWith = /\b(not|never|n't|shouldn't|should not|must not|cannot|can't|avoid)\b[^.]{0,40}\b(with|alongside|same shift as|together)\b/.test(t);
    const posWith = /\b(must|should|always|needs? to|has to)\b[^.]{0,40}\b(with|alongside|together)\b/.test(t);
    let n: number | null;
    if (people.length >= 2 && (negWith || posWith)) {
      template = "work_with"; other = people[1].id; params = { participant_id: people[1].id, together: !negWith };
      why.push(`Read as: ${people[0].name} ${negWith ? "must not" : "must"} be on shift with ${people[1].name}.`);
    } else if ((n = num(/at least\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b[^.]{0,30}\b(?:off|between|rest)/)) !== null) {
      template = "min_hours_off_between_shifts"; params = { hours: n }; why.push(`Read "${n} hours" as the minimum time off between shifts.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+(?:consecutive nights?|nights? in a row)"))) !== null) {
      template = "max_nights_in_a_row"; params = { n }; why.push(`Read as at most ${n} nights in a row.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+(?:consecutive (?:shifts?|days?)|(?:shifts?|days?) in a row)"))) !== null) {
      template = "max_consecutive_shifts"; params = { n }; why.push(`Read as at most ${n} consecutive shifts.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+(?:night|overnight)s?"))) !== null) {
      template = "max_nights_per_interval"; params = { n }; why.push(`Read as at most ${n} night shifts per interval.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+weekends?"))) !== null) {
      template = "weekends_per_interval"; params = { min: 0, max: n }; why.push(`Read as at most ${n} weekends per interval.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+shifts?\\s+(?:per|a|each|every|in a)\\s+week"))) !== null) {
      template = "max_shifts_per_week"; params = { n }; why.push(`Read as at most ${n} shifts per week.`);
    } else if ((n = num(new RegExp(cap + "(\\d+)\\s+shifts?"))) !== null) {
      template = "max_shifts_per_interval"; params = { n }; why.push(`Read as at most ${n} shifts per interval.`);
    } else if (/\b(can't|cannot|can not|unavailable|not available|unable|no |never|off|shouldn't|should not|must not|avoid|rather not|prefer not|not work|doesn't work|does not work)\b/.test(t)
      && (cats.length || insts.length || wd.length || dates)) {
      template = "unavailable"; params = {};
      if (cats.length) { params.category_ids = cats.map((c) => c.id); why.push(`Read the shift type as: ${cats.map((c) => c.name).join(", ")}.`); }
      if (insts.length) { params.institution_ids = insts.map((i) => i.id); why.push(`Read the place as: ${insts.map((i) => i.name).join(", ")}.`); }
      if (wd.length) { params.weekdays = wd; why.push(`Read the days as: ${DAYS.filter(([re]) => re.test(t)).map(([, , l]) => l).join(", ")}.`); }
    }
    const who = people[0] ?? null;
    if (who) why.unshift(`Recognised ${who.name}.`);
    else if (role) why.unshift(`Recognised the role ${role.name}.`);
    if (dates && template !== "custom") why.push(`Read the dates as ${dates.read}.`);
    const tpl = TEMPLATE[template];
    let scope: Proposal["scope"] = who ? "PARTICIPANT" : role ? "ROLE" : "PROGRAM";
    if (!tpl.scopes.includes(scope)) { why.push(`This kind of rule cannot be set for a single ${scope.toLowerCase()}; proposed for the whole program instead.`); scope = tpl.scopes.includes("PROGRAM") ? "PROGRAM" : (tpl.scopes[0] as Proposal["scope"]); }
    let level: Proposal["level"] = soft ? "SOFT" : "HARD";
    if (!tpl.levels.includes(level)) level = tpl.levels[0] as Proposal["level"];
    const unmapped = template === "custom";
    if (unmapped) { level = "SOFT"; why.push("Could not match this to a rule template. It will be kept as a custom rule, flagged for manual review, and never enforced automatically."); }
    else why.push(soft ? "Wording such as \"prefer\" or \"try\" suggests a soft rule." : "No softening words, so proposed as a hard rule.");
    void other;
    return {
      template, params, scope, level, weight: level === "SOFT" ? (/\bstrongly|really|very\b/.test(t) ? 8 : 5) : null,
      participantId: scope === "PARTICIPANT" ? who!.id : null, roleId: scope === "ROLE" ? role?.id ?? null : null, institutionId: null,
      activeFrom: unmapped ? null : dates?.from ?? null, activeTo: unmapped ? null : dates?.to ?? null,
      notes: "", needsReview: unmapped, explanation: why,
    };
  }
}

const PROVIDERS: Record<string, () => RuleInterpreter> = {
  mock: () => new MockRuleInterpreter(),
  // anthropic: () => new AnthropicRuleInterpreter(process.env.ANTHROPIC_API_KEY!),   <- add real providers here
};
export function getRuleInterpreter(): RuleInterpreter {
  return (PROVIDERS[process.env.RULE_PARSER ?? "mock"] ?? PROVIDERS.mock)();
}
