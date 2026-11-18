// Words, colours and small calculations shared by the screens that show a generated schedule.
import { dow } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The engine's goals in its own order, in the words the admin screens use. Lower is better; 0 = fully met. */
export const GOALS: Record<string, { label: string; counts: string }> = {
  "open shifts": { label: "Every shift filled", counts: "shifts left open" },
  "contract shortfall": { label: "Everyone reaches their minimum shifts", counts: "shifts short of a minimum" },
  "site split": { label: "Split between institutions", counts: "shifts beyond the one-shift tolerance of each person's target split" },
  "backward rotations": { label: "Forward rotation", counts: "times someone moves to an earlier shift type the next day" },
  "day/evening/night balance": { label: "Balance across shift types", counts: "shifts beyond the one-shift tolerance" },
  "night runs too close": { label: "Time between runs of nights", counts: "runs of nights that start too soon after the last" },
  "nights into vacation": { label: "No night before time off", counts: "nights that end on a vacation day" },
  "night share over limit": { label: "Share of nights within the limit", counts: "night hours over the limit" },
  "pod balance": { label: "Balance between areas", counts: "shifts beyond the tolerance between paired areas" },
  "isolated days off": { label: "Days off kept together", counts: "single days off between two working days" },
  "extra / over-long night runs": { label: "One run of nights, not too long", counts: "extra or over-long runs of nights" },
  "requests off missed": { label: "Requests off granted", counts: "request days not granted, weighted by priority" },
};

/** How many person-shifts an interval's inputs ask for (the same count the engine makes). */
export function shiftsToFill(config: Any, start: Date): number {
  let total = 0;
  for (const t of config.shift_templates as Any[]) {
    if (!(t.headcount > 0)) continue;
    for (let d = 0; d < config.n_days; d++) {
      const runs = t.only_days ? t.only_days.includes(d) : (t.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(dow(new Date(start.getTime() + d * 86400000))) && !(t.except_days ?? []).includes(d);
      if (runs) total += t.headcount;
    }
  }
  return total;
}

/** Short codes for the grid: "Day GP" -> DGP, "Night M" -> NM, "Day M (after conference)" -> DM*. Unique per schedule. */
export function shortCodes(names: string[]): Map<string, string> {
  const out = new Map<string, string>(), used = new Set<string>();
  for (const name of [...new Set(names)].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const base = name.replace(/\(.*?\)/g, " ").trim().split(/[\s/-]+/).filter(Boolean)
      .map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase())).join("").slice(0, 4) || "?";
    let code = base + (/\(/.test(name) ? "*" : "");
    for (let i = 2; used.has(code); i++) code = `${base}${i}`;
    used.add(code);
    out.set(name, code);
  }
  return out;
}

const PALETTE = ["#d97706", "#ea580c", "#db2777", "#0d9488", "#65a30d", "#0284c7"];
/** A colour per shift category: the admin's own if set, otherwise by rotation order, nights always indigo. */
export function categoryColors(cats: { id: string; color: string | null; isNight: boolean; sortOrder: number }[]): Map<string, string> {
  const sorted = [...cats].sort((a, b) => a.sortOrder - b.sortOrder);
  let i = 0;
  return new Map(sorted.map((c) => [c.id, c.color || (c.isNight ? "#4f46e5" : PALETTE[i++ % PALETTE.length])]));
}
export const tint = (color: string, pct = 20) => `color-mix(in srgb, ${color} ${pct}%, white)`;

export const fmtWhen = (d: Date | null | undefined, timeZone: string) =>
  d ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) : "";
export const fmtDuration = (s: number) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);
export const clockTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const RUN_TONE = { QUEUED: "blue", RUNNING: "blue", DONE: "gray", FAILED: "red", CANCELLED: "gray" } as const;
export const SCHEDULE_TONE = { DRAFT: "gray", PUBLISHED: "green", SUPERSEDED: "gray" } as const;
/** One word for where a schedule stands. */
export function standing(s: { status: string; runStatus: string }): { text: string; tone: "gray" | "green" | "red" | "blue" | "amber" } {
  if (s.runStatus === "RUNNING" || s.runStatus === "QUEUED") return { text: "Generating", tone: "blue" };
  if (s.runStatus === "FAILED") return { text: "Failed", tone: "red" };
  if (s.runStatus === "CANCELLED") return { text: "Cancelled", tone: "gray" };
  if (s.status === "PUBLISHED") return { text: "Published", tone: "green" };
  if (s.status === "SUPERSEDED") return { text: "Replaced", tone: "gray" };
  return { text: "Draft", tone: "amber" };
}
