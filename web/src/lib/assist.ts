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
function mockBackup(text: string, roles: (Named & { level: number })[]): BackupProposal {
  const t = low(text), why: string[] = [];
  const r: BackupRules = cleanBackupRules({});
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`(?:no more than|not more than|at most|max(?:imum)?(?: of)?|up to|limit(?:ed)? to)\\s+${N}\\s*(?:backup|back-up|on[- ]call)?\\s*(?:days?|shifts?|times?|each|per person|a person|apiece)`).exec(t))) {
    r.max_per_person = numOf(m[1]); why.push(`At most ${r.max_per_person} backup days per person.`);
  }
  if ((m = new RegExp(`(?:at least\\s+)?${N}\\s+days?\\s+(?:apart|between)`).exec(t))) { r.min_days_between = numOf(m[1]); why.push(`At least ${r.min_days_between} days between one person's backups.`); }
  if ((m = new RegExp(`${N}\\s*(?:hours?|hrs?|h)\\b[^.]{0,25}\\b(?:before)`).exec(t))) { r.rest_before_hours = numOf(m[1]); why.push(`${r.rest_before_hours} hours free of shifts before backup.`); }
  if ((m = new RegExp(`${N}\\s*(?:hours?|hrs?|h)\\b[^.]{0,25}\\b(?:after)`).exec(t))) { r.rest_after_hours = numOf(m[1]); why.push(`${r.rest_after_hours} hours free of shifts after backup.`); }
  if (/\b(counts? as (a )?(worked )?shift|counts? toward|count it as)\b/.test(t) && !/\b(not|doesn't|does not|don't)\b[^.]{0,15}\bcount/.test(t)) { r.counts_as_shift = true; why.push("Counts as a worked shift."); }
  let eligible: string[] | null = null;
  if ((m = /\bpgy-?\s?(\d)\s*(?:and (?:up|above|higher)|\+|or (?:above|higher|senior))/.exec(t))) {
    const lvl = Number(m[1]); eligible = roles.filter((x) => x.level >= lvl).map((x) => x.id); why.push(`Only PGY-${lvl} and up (${roles.filter((x) => x.level >= lvl).map((x) => x.name).join(", ")}).`);
  } else if ((m = /\bonly\s+pgy-?\s?(\d)s?\b/.exec(t) ?? /\bpgy-?\s?(\d)s?\s+only\b/.exec(t))) {
    const lvl = Number(m[1]); eligible = roles.filter((x) => x.level === lvl).map((x) => x.id); why.push(`Only PGY-${lvl}.`);
  }
  const used = why.length;
  if (!used) why.push("No rule was recognised in this text.");
  const leftover = text.split(/(?<=[.;])\s+/).filter((sentence) => {
    const s = low(sentence);
    return !/(\d|one|two|three|four|five|six|seven|eight|nine|ten)\b.*\b(days?|hours?|shifts?|times?|each|per person|apart)\b|pgy|counts?/.test(s);
  }).join(" ").trim();
  if (leftover) { r.not_understood = leftover; why.push(`Not understood, so not enforced: "${leftover}"`); }
  return { rules: r, eligibleRoleIds: eligible, explanation: why, by: "keyword stand-in" };
}

export async function proposeBackupRules(text: string, ctx: { today: string; roles: (Named & { level: number })[] }): Promise<BackupProposal> {
  return withFallback(async () => {
    const out = await askForTool<{ max_per_person: number | null; min_days_between: number; rest_before_hours: number; rest_after_hours: number; counts_as_shift: boolean;
      eligible_role_ids: string[] | null; not_understood: string; explanation: string[] }>({
      system: [
        "You turn an emergency medicine residency administrator's description of their BACKUP (on-call, at home) shift into structured rules.",
        "Backup is assigned once a day to one person who is not working that day. Fields:",
        "max_per_person: most backup days for one person in a scheduling interval, or null for no limit.",
        "min_days_between: at least this many days between two backup days of one person (0 = no spacing).",
        "rest_before_hours / rest_after_hours: hours free of clinical shifts required before / after the backup period.",
        "counts_as_shift: true only if the text says backup counts as a worked shift toward shift totals or hours; default false.",
        "eligible_role_ids: the roles allowed to take backup if the text limits it (use ids from the list), else null.",
        "not_understood: any part of the text these fields cannot express, quoted, else empty. Do not stretch a field to fit.",
        "explanation: short plain sentences saying how you read the text.",
      ].join("\n"),
      user: `${contextBlock({ today: ctx.today, roles: ctx.roles.map((r) => ({ id: r.id, name: `${r.name} (level ${r.level})` })) })}\n\nBackup shift rules:\n${text}`,
      tool: { name: "propose_backup_rules", description: "The backup shift's rules.", input_schema: { type: "object",
        required: ["max_per_person", "min_days_between", "rest_before_hours", "rest_after_hours", "counts_as_shift", "eligible_role_ids", "not_understood", "explanation"],
        properties: {
          max_per_person: { type: ["integer", "null"], minimum: 0, maximum: 31 }, min_days_between: { type: "integer", minimum: 0, maximum: 14 },
          rest_before_hours: { type: "number", minimum: 0, maximum: 48 }, rest_after_hours: { type: "number", minimum: 0, maximum: 48 },
          counts_as_shift: { type: "boolean" }, eligible_role_ids: { type: ["array", "null"], items: { type: "string" } },
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
      lines.push({ action: "ADD", shiftId: shift?.id ?? null, name: shift ? `${shift.name} (extra)` : `Extra ${cat ? cat.name.toLowerCase() : ""} shift`.replace("  ", " "), categoryId: shift?.categoryId ?? cat?.id ?? null,
        startMinute: st, durationMinutes: hours ? Math.round(Number(hours[1]) * 60) : null, minParticipants: people ? numOf(people[1]) : null });
      why.push(`An extra ${shift ? shift.name : "shift"}${st != null ? ` at ${hhmm(st)}` : ""}${hours ? ` for ${hours[1]}h` : ""}.`);
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
        "ADD: an extra shift that day (shift_id of a shift to copy, or null; name; category_id; start; hours; people).",
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
