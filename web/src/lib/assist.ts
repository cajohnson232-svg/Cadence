// Plain English -> proposals, for a backup shift's rules and for a special staffing day's changes.
// Claude when ANTHROPIC_API_KEY is set (lib/ai.ts); otherwise, or if Claude fails, a keyword stand-in.
// Everything returned is a proposal the administrator edits and confirms; nothing here saves anything.
import { aiConfigured, aiLabel, askForTool, contextBlock } from "./ai";
import { cleanBackupRules, type BackupRules } from "./backup-rules";
import { hhmm, toMinutes } from "./util";

type Named = { id: string; name: string };
export type BackupProposal = { rules: BackupRules; eligibleRoleIds: string[] | null; explanation: string[]; by: string };
export type DayShift = Named & { startMinute: number; durationMinutes: number; minParticipants: number; categoryId: string; runsThatDay: boolean; active: boolean };
export type DayLine = { action: "ADD" | "CHANGE" | "REMOVE"; shiftId: string | null; name: string | null; categoryId: string | null; startMinute: number | null; durationMinutes: number | null; minParticipants: number | null };
export type DayProposal = { lines: DayLine[]; explanation: string[]; by: string };

const low = (t: string) => " " + t.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ") + " ";
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14 };
const numOf = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NUM[s] ?? NaN);
const N = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen)";

async function withFallback<T extends { by: string }>(claude: () => Promise<T>, mock: () => T): Promise<T> {
  if (!aiConfigured()) return mock();
  try { return await claude(); } catch (e) {
    const m = mock();
    return { ...m, by: `${m.by}, because ${(e as Error).message}` };
  }
}

// ───────────────────────────── backup rules ─────────────────────────────
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };

/** Who may take backup, from one sentence: PGY numbers ("PGY-2s and PGY-3s", "PGY2/3", "PGY-2 and up"), years
 *  ("second and third years"), interns, juniors and seniors; "not"/"no"/"except" before them excludes instead. */
function backupRoles(s: string, roles: (Named & { level: number })[]): { ids: string[]; why: string } | null {
  const levels = [...new Set(roles.map((r) => r.level))].sort((a, b) => a - b), top = levels[levels.length - 1];
  const named = new Set<number>();
  let up: number | null = null;
  for (const m of s.matchAll(/\bpgy[- ]?(\d)((?:\s*(?:\/|,|&|and|or)\s*(?:pgy[- ]?)?\d)*)/g)) {
    named.add(Number(m[1]));
    for (const d of (m[2] ?? "").matchAll(/(\d)/g)) named.add(Number(d[1]));
    if (new RegExp(`^pgy[- ]?${m[1]}s?\\s*(?:and (?:up|above|higher|older)|\\+|or (?:above|higher|more senior|senior))`).test(s.slice(m.index!))) up = Number(m[1]);
  }
  for (const m of s.matchAll(/\b(first|second|third|fourth|1st|2nd|3rd|4th)(?:\s*(?:,|and|or|&)\s*(first|second|third|fourth|1st|2nd|3rd|4th))*[- ]years?\b/g))
    for (const w of m[0].match(/first|second|third|fourth|1st|2nd|3rd|4th/g) ?? []) named.add(ORD[w]);
  if (/\binterns?\b|\bjuniors?\b|\bjunior residents?\b/.test(s)) named.add(levels[0]);
  const seniors = /\bseniors?\b|\bsenior residents?\b|\bupper[- ]levels?\b/.test(s);
  if (!named.size && !seniors && up == null) return null;
  const neg = /\b(no|not|never|cannot|can't|can not|except|excluding|other than|aren't|isn't|shouldn't|should not|may not)\b[^.]{0,40}\b(pgy|interns?|juniors?|first|second|third|fourth|1st|2nd|3rd|4th|seniors?|upper)/.test(s)
    || /\b(pgy[- ]?\d|interns?|juniors?|seniors?|years?)\b[^.]{0,25}\b(can't|cannot|can not|are not|aren't|may not|must not|should not|shouldn't|never|don't|do not|not allowed|excluded|exempt)\b/.test(s);
  let pick: (l: number) => boolean;
  if (up != null) pick = (l) => l >= up!;
  else if (neg) pick = (l) => !named.has(l) && !(seniors && l === top);
  else pick = (l) => named.has(l) || (seniors && l === top) || (seniors && named.size === 0 && l === top);
  const ids = roles.filter((r) => pick(r.level)).map((r) => r.id);
  if (!ids.length) return null;
  return { ids, why: `Can take backup: ${roles.filter((r) => pick(r.level)).map((r) => r.name).join(", ")}${seniors && !named.size && up == null ? " (\"seniors\" read as the most senior level; change below if you mean more)" : ""}.` };
}

function mockBackup(text: string, roles: (Named & { level: number })[]): BackupProposal {
  const why: string[] = [], left: string[] = [];
  const r: BackupRules = cleanBackupRules({});
  let eligible: string[] | null = null;
  const sentences = text.split(/(?<=[.;!?\n])\s+|\s*\n\s*|\s+(?:and|but)\s+(?=(?:no|not|never|nobody|no one|each|every|everyone|at least|at most|max|only|they|it|backup)\b)/i).map((x) => x.trim()).filter((x) => x.replace(/[.;!?\s]/g, ""));
  for (const raw of sentences) {
    const t = low(raw), before = why.length;
    let m: RegExpExecArray | null;
    // most per person
    if ((m = new RegExp(`(?:no more than|not more than|at most|max(?:imum)?(?: of)?|up to|limit(?:ed)? to|cap(?:ped)? at|cap of|never more than)\\s+${N}\\b`).exec(t)) ??
        (m = new RegExp(`\\b${N}\\s*(?:backups?|back-ups?|on[- ]calls?|days?|shifts?|times?)?\\s*(?:max(?:imum)?|at most|tops)\\b`).exec(t)) ??
        (m = new RegExp(`\\b(?:each|every)(?: person| resident| one)? (?:gets?|has|takes?|does|works?|covers?) (?:no more than |at most |up to )?${N}\\b(?! or more)`).exec(t))) {
      if (!/\bat least\b|\bminimum\b|\bor more\b/.test(t.slice(0, m.index + m[0].length + 10)) || /\bat most|no more|max|up to|limit|cap/.test(m[0])) {
        r.max_per_person = numOf(m[1]); why.push(`At most ${r.max_per_person} backup days per person.`);
      }
    }
    // least per person
    if ((m = new RegExp(`(?:at least|a minimum of|minimum(?: of)?|no fewer than|not less than)\\s+${N}\\s*(?:backups?|back-ups?|on[- ]calls?|days?|shifts?|times?)?\\s*(?:each|per person|a person|apiece|per resident|for everyone|for each)`).exec(t)) ??
        (m = new RegExp(`\\b(?:everyone|everybody|each (?:person|resident|senior)|every (?:person|resident|senior))\\b[^.]{0,30}\\b(?:at least|minimum(?: of)?)\\s+${N}\\b`).exec(t))) {
      r.min_per_person = numOf(m[1]); why.push(`At least ${r.min_per_person} backup day${r.min_per_person === 1 ? "" : "s"} per eligible person, where possible.`);
    }
    // spacing
    if ((m = new RegExp(`(?:at least\\s+)?${N}\\s+(?:full\\s+)?days?\\s+(?:apart|between|in between|off between|gap)`).exec(t)) ??
        (m = new RegExp(`\\b(?:no two|not two)\\b[^.]{0,30}\\bwithin\\s+${N}\\s+days?`).exec(t))) {
      r.min_days_between = numOf(m[1]); why.push(`At least ${r.min_days_between} days between one person's backups.`);
    } else if (/\b(back[- ]to[- ]back|consecutive days?|two days in a row|days in a row|in a row)\b/.test(t) && /\b(no|not|never|avoid|nobody|no one)\b/.test(t) && !/night/.test(t)) {
      r.min_days_between = Math.max(r.min_days_between, 1); why.push("Not on back-to-back days (at least 1 day between one person's backups).");
    }
    // nights and vacation next to backup
    const nightAfter = /\b(after|following|post|coming off|off of|off)\b[^.]{0,20}\bnights?\b|\bpost[- ]?nights?\b/.test(t);
    const nightBefore = /\b(before|prior to|ahead of|leading into|going into|the day before)\b[^.]{0,20}\bnights?\b/.test(t);
    if (/\bnights?\b/.test(t) && /\b(no|not|never|nobody|no one|cannot|can't|shouldn't|should not|avoid|isn't|aren't)\b/.test(t)) {
      if (nightAfter || (!nightBefore && /\b(around|next to|adjacent|surrounding|either side)\b/.test(t))) { r.not_after_night = true; why.push("Not the day after a night shift."); }
      if (nightBefore || /\b(around|next to|adjacent|surrounding|either side|before or after|after or before)\b/.test(t)) { r.not_before_night = true; why.push("Not the day before a night shift."); }
      if (!nightAfter && !nightBefore && !/\b(around|next to|adjacent|surrounding|either side)\b/.test(t) && /\b(on|during|working)\b[^.]{0,15}\bnights?\b/.test(t))
        why.push("Nobody is on backup on a day they work any shift, nights included (always the case).");
    }
    if (/\b(vacation|holiday leave|pto|time off|leave)\b/.test(t) && /\b(before|after|next to|adjacent|around|either side|surrounding|leading into|coming back|back from|returning)\b/.test(t)
        && /\b(no|not|never|nobody|no one|avoid|cannot|can't|shouldn't|should not)\b/.test(t)) {
      r.not_next_to_vacation = true; why.push("Not the day before vacation starts or the day after it ends.");
    }
    // rest in hours
    if ((m = new RegExp(`${N}\\s*(?:hours?|hrs?|h)\\b[^.]{0,30}\\b(?:before)`).exec(t))) { r.rest_before_hours = numOf(m[1]); why.push(`${r.rest_before_hours} hours free of shifts before backup.`); }
    if ((m = new RegExp(`${N}\\s*(?:hours?|hrs?|h)\\b[^.]{0,30}\\b(?:after)`).exec(t))) { r.rest_after_hours = numOf(m[1]); why.push(`${r.rest_after_hours} hours free of shifts after backup.`); }
    // counts as a shift, or not
    if (/\b(counts? as (a )?(worked )?shift|counts? toward|count it as|counted as (a )?shift)\b/.test(t) && !/\b(not|doesn't|does not|don't|do not|never)\b[^.]{0,20}\bcount/.test(t)) { r.counts_as_shift = true; why.push("Counts as a worked shift."); }
    else if (/\b(not|doesn't|does not|don't|do not|never)\b[^.]{0,20}\bcount|\bon[- ]call only\b|\bfrom home\b|\bat home\b/.test(t)) why.push("On call only: does not count toward shifts or hours (the default).");
    // who
    const who = backupRoles(t, roles);
    if (who) { if (JSON.stringify(who.ids) !== JSON.stringify(eligible)) why.push(who.why); else if (why.length === before) why.push(""); eligible = who.ids; }
    // fairness: already how backup is chosen
    if (/\b(even(ly)?|equal(ly)?|fair(ly)?|same number|balanced?|spread|share|distribute|roughly the same)\b/.test(t)) why.push("Spread as evenly as possible (always the case).");
    if (why.length === before) left.push(raw.replace(/\s+/g, " "));
  }
  const seen = new Set<string>();
  why.splice(0, why.length, ...why.filter((w) => w && !seen.has(w) && seen.add(w)));
  if (left.length) {
    r.not_understood = left.join(" ");
    why.push(why.length ? `Not understood, so not enforced: "${r.not_understood}". Set it with the fields below if one fits, or reword it.`
      : "The built-in reader did not recognise any rule in these words. Set the rules with the fields below (your words are saved with them), or reword using the examples in the box.");
  }
  return { rules: r, eligibleRoleIds: eligible, explanation: why, by: "keyword stand-in" };
}

export async function proposeBackupRules(text: string, ctx: { today: string; roles: (Named & { level: number })[] }): Promise<BackupProposal> {
  return withFallback(async () => {
    const out = await askForTool<{ max_per_person: number | null; min_days_between: number; rest_before_hours: number; rest_after_hours: number; counts_as_shift: boolean;
      min_per_person: number | null; not_after_night: boolean; not_before_night: boolean; not_next_to_vacation: boolean;
      eligible_role_ids: string[] | null; not_understood: string; explanation: string[] }>({
      system: [
        "You turn an emergency medicine residency administrator's description of their BACKUP (on-call, at home) shift into structured rules.",
        "Backup is assigned once a day to one person who is not working that day. Fields:",
        "max_per_person: most backup days for one person in a scheduling interval, or null for no limit.",
        "min_days_between: at least this many days between two backup days of one person (0 = no spacing).",
        "rest_before_hours / rest_after_hours: hours free of clinical shifts required before / after the backup period.",
        "counts_as_shift: true only if the text says backup counts as a worked shift toward shift totals or hours; default false.",
        "min_per_person: at least this many backup days for each eligible person (aimed for), or null.",
        "not_after_night / not_before_night: true if the text says no backup the day after / the day before a night shift.",
        "not_next_to_vacation: true if the text says no backup right before or right after a vacation.",
        "Backup is always spread as evenly as possible and never on a day the person works; say so in the explanation rather than in not_understood.",
        "eligible_role_ids: the roles allowed to take backup if the text limits it (use ids from the list), else null.",
        "not_understood: any part of the text these fields cannot express, quoted, else empty. Do not stretch a field to fit.",
        "explanation: short plain sentences saying how you read the text.",
      ].join("\n"),
      user: `${contextBlock({ today: ctx.today, roles: ctx.roles.map((r) => ({ id: r.id, name: `${r.name} (level ${r.level})` })) })}\n\nBackup shift rules:\n${text}`,
      tool: { name: "propose_backup_rules", description: "The backup shift's rules.", input_schema: { type: "object",
        required: ["max_per_person", "min_days_between", "rest_before_hours", "rest_after_hours", "counts_as_shift", "min_per_person", "not_after_night", "not_before_night",
          "not_next_to_vacation", "eligible_role_ids", "not_understood", "explanation"],
        properties: {
          max_per_person: { type: ["integer", "null"], minimum: 0, maximum: 31 }, min_days_between: { type: "integer", minimum: 0, maximum: 14 },
          rest_before_hours: { type: "number", minimum: 0, maximum: 48 }, rest_after_hours: { type: "number", minimum: 0, maximum: 48 },
          counts_as_shift: { type: "boolean" }, min_per_person: { type: ["integer", "null"], minimum: 0, maximum: 31 },
          not_after_night: { type: "boolean" }, not_before_night: { type: "boolean" }, not_next_to_vacation: { type: "boolean" }, eligible_role_ids: { type: ["array", "null"], items: { type: "string" } },
          not_understood: { type: "string" }, explanation: { type: "array", items: { type: "string" } },
        } } },
    });
    const known = new Set(ctx.roles.map((r) => r.id));
    return {
      rules: cleanBackupRules({ ...out, not_understood: out.not_understood }),
      eligibleRoleIds: Array.isArray(out.eligible_role_ids) ? out.eligible_role_ids.filter((x) => known.has(x)) : null,
      explanation: Array.isArray(out.explanation) ? out.explanation.map(String).slice(0, 12) : [], by: aiLabel(),
    };
  }, () => mockBackup(text, ctx.roles));
}

// ───────────────────────────── special staffing day changes ─────────────────────────────
function mockDay(text: string, shifts: DayShift[], categories: Named[] = []): DayProposal {
  const why: string[] = [], lines: DayLine[] = [];
  const running = shifts.filter((s) => s.runsThatDay);
  const sentences = text.split(/(?<=[.;\n])\s*|\s+(?:and|then)\s+(?=(?:no|cancel|drop|remove|add|start|move|only|the)\b)/i).map((x) => x.trim()).filter(Boolean);
  const find = (s: string, pool: DayShift[]) => pool
    .filter((x) => new RegExp(`\\b${x.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`).test(s))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const time = (s: string) => {
    const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(s.replace(/\b\d+\s*(?:hours?|hrs?|h|people|residents|persons?)\b/g, ""));
    if (!m) return null;
    let h = Number(m[1]); if (m[3] === "pm" && h < 12) h += 12; if (m[3] === "am" && h === 12) h = 0;
    return h < 24 ? h * 60 + Number(m[2] ?? 0) : null;
  };
  const left: string[] = [];
  for (const raw of sentences) {
    const s = low(raw), shift = find(s, running) ?? find(s, shifts);
    const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/.exec(s), people = new RegExp(`${N}\\s+(?:people|residents|persons?|on)\\b`).exec(s);
    if (shift && /\b(no|cancel(?:led)?|drop|remove|closed|not run|doesn't run|won't run|skip)\b/.test(s)) {
      lines.push({ action: "REMOVE", shiftId: shift.id, name: null, categoryId: null, startMinute: null, durationMinutes: null, minParticipants: null });
      why.push(`${shift.name} does not run.`);
    } else if (/\b(add|extra|another|one more|additional)\b/.test(s) && (shift || time(s) != null)) {
      const st = time(s);
      const cat = categories.find((c) => new RegExp(`\\b${c.name.toLowerCase()}\\b`).test(s));
      const like = shift ?? shifts.find((x) => cat && x.categoryId === cat.id) ?? null;     // who may work it comes from the shift it copies
      lines.push({ action: "ADD", shiftId: like?.id ?? null, name: shift ? `${shift.name} (extra)` : `Extra ${cat ? cat.name.toLowerCase() : ""} shift`.replace("  ", " "), categoryId: shift?.categoryId ?? cat?.id ?? null,
        startMinute: st, durationMinutes: hours ? Math.round(Number(hours[1]) * 60) : null, minParticipants: people ? numOf(people[1]) : null });
      why.push(`An extra ${shift ? shift.name : "shift"}${st != null ? ` at ${hhmm(st)}` : ""}${hours ? ` for ${hours[1]}h` : ""}.`);
      if (!shift) why.push(like ? `It copies ${like.name}, so the same roles can work it; change that if another shift fits better.` : "Choose which normal shift it is like: its role grid decides who can work it.");
    } else if (shift && (time(s) != null || hours || people)) {
      const st = /\b(start|starts|begin|begins|at|from|moved? to)\b/.test(s) ? time(s) : null;
      lines.push({ action: "CHANGE", shiftId: shift.id, name: null, categoryId: null, startMinute: st, durationMinutes: hours ? Math.round(Number(hours[1]) * 60) : null, minParticipants: people ? numOf(people[1]) : null });
      why.push(`${shift.name} changes:${st != null ? ` starts ${hhmm(st)}` : ""}${hours ? ` lasts ${hours[1]}h` : ""}${people ? ` needs ${numOf(people[1])}` : ""}.`);
    } else left.push(raw);
  }
  if (left.length) why.push(`Not understood: "${left.join(" ")}". Add or change these lines by hand.`);
  if (!lines.length && !left.length) why.push("No change was recognised.");
  return { lines, explanation: why, by: "keyword stand-in" };
}

export async function proposeSpecialDay(text: string, ctx: { today: string; date: string; institution: string; shifts: DayShift[]; categories: (Named & { isNight: boolean })[] }): Promise<DayProposal> {
  return withFallback(async () => {
    const out = await askForTool<{ lines: { action: string; shift_id: string | null; name: string | null; category_id: string | null; start: string | null; hours: number | null; people: number | null }[]; explanation: string[] }>({
      system: [
        `You turn an administrator's description of how one day's staffing changes at ${ctx.institution} on ${ctx.date} into change lines.`,
        "The shifts listed with 'runs that day' normally run on that date. Each line is one of:",
        "REMOVE: a normal shift does not run (shift_id required).",
        "CHANGE: a normal shift runs differently (shift_id required; set only what changes: start HH:MM, hours, people).",
        "ADD: an extra shift that day. shift_id is required: the normal shift it is most like (same area and kind of work), whose role eligibility decides who may work it; then name, category_id, start, hours, people as needed.",
        "Use only ids from the lists. Leave a field null when the text does not say. explanation: short plain sentences, including anything you could not express.",
      ].join("\n"),
      user: `${contextBlock({ today: ctx.today, categories: ctx.categories,
        shifts: ctx.shifts.map((s) => ({ id: s.id, name: s.name, start: hhmm(s.startMinute), hours: s.durationMinutes / 60, headcount: s.minParticipants, category: ctx.categories.find((c) => c.id === s.categoryId)?.name ?? "", days: s.runsThatDay ? "runs that day" : "does not normally run that day" })) })}\n\nChanges:\n${text}`,
      tool: { name: "propose_day_changes", description: "The changes to that day's shifts.", input_schema: { type: "object", required: ["lines", "explanation"], properties: {
        lines: { type: "array", items: { type: "object", required: ["action"], properties: {
          action: { type: "string", enum: ["ADD", "CHANGE", "REMOVE"] }, shift_id: { type: ["string", "null"] }, name: { type: ["string", "null"] }, category_id: { type: ["string", "null"] },
          start: { type: ["string", "null"], description: "HH:MM, 24-hour" }, hours: { type: ["number", "null"] }, people: { type: ["integer", "null"] } } } },
        explanation: { type: "array", items: { type: "string" } } } } },
    });
    const ids = new Set(ctx.shifts.map((s) => s.id)), cats = new Set(ctx.categories.map((c) => c.id));
    const lines: DayLine[] = [];
    for (const l of out.lines ?? []) {
      const action = (["ADD", "CHANGE", "REMOVE"] as const).find((a) => a === l.action);
      const shiftId = l.shift_id && ids.has(l.shift_id) ? l.shift_id : null;
      if (!action || (action !== "ADD" && !shiftId)) continue;
      const st = typeof l.start === "string" && /^\d{1,2}:\d{2}$/.test(l.start) ? toMinutes(l.start) : null;
      lines.push({ action, shiftId, name: action === "ADD" ? (l.name || null) : null, categoryId: l.category_id && cats.has(l.category_id) ? l.category_id : null,
        startMinute: st != null && st < 1440 ? st : null, durationMinutes: typeof l.hours === "number" && l.hours > 0 && l.hours <= 48 ? Math.round(l.hours * 60) : null,
        minParticipants: typeof l.people === "number" && l.people >= 0 && l.people <= 50 ? Math.round(l.people) : null });
    }
    return { lines, explanation: Array.isArray(out.explanation) ? out.explanation.map(String).slice(0, 12) : [], by: aiLabel() };
  }, () => mockDay(text, ctx.shifts, ctx.categories));
}
