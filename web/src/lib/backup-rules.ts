// A backup (on-call) shift's rules, as stored on the shift and given to the engine.
// The administrator writes them in plain words; the AI (or the keyword stand-in) proposes these values,
// and the administrator confirms them on the shift's form.

export type BackupRules = {
  max_per_person: number | null; // most backup days for one person in an interval (null = no limit)
  min_days_between: number; // at least this many days between two of one person's backup days (0 = none)
  rest_before_hours: number; // hours free of clinical shifts before backup starts
  rest_after_hours: number; // ... and after it ends
  counts_as_shift: boolean; // true = a worked shift (counts toward shifts and hours); false = on call only
  min_per_person: number | null; // aimed for: each eligible person gets at least this many (null = no minimum)
  not_after_night: boolean; // never the day after a night shift
  not_before_night: boolean; // never the day before a night shift
  not_next_to_vacation: boolean; // never the day before vacation starts or the day after it ends
  not_understood?: string; // anything in the administrator's words that could not be turned into a rule
};

export const DEFAULT_BACKUP_RULES: BackupRules = { max_per_person: null, min_days_between: 0, rest_before_hours: 0, rest_after_hours: 0, counts_as_shift: false,
  min_per_person: null, not_after_night: false, not_before_night: false, not_next_to_vacation: false };

/** Values read back from the database, filled with defaults, limited to sensible ranges. */
export function cleanBackupRules(v: unknown): BackupRules {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    max_per_person: o.max_per_person == null || o.max_per_person === "" ? null : Math.round(num(o.max_per_person, 0, 31, 0)),
    min_days_between: Math.round(num(o.min_days_between, 0, 14, 0)),
    rest_before_hours: num(o.rest_before_hours, 0, 48, 0),
    rest_after_hours: num(o.rest_after_hours, 0, 48, 0),
    counts_as_shift: o.counts_as_shift === true,
    min_per_person: o.min_per_person == null || o.min_per_person === "" || o.min_per_person === 0 ? null : Math.round(num(o.min_per_person, 0, 31, 0)),
    not_after_night: o.not_after_night === true,
    not_before_night: o.not_before_night === true,
    not_next_to_vacation: o.not_next_to_vacation === true,
    ...(typeof o.not_understood === "string" && o.not_understood.trim() ? { not_understood: o.not_understood.trim().slice(0, 1000) } : {}),
  };
}

export function describeBackupRules(r: BackupRules): string {
  const parts = [
    r.counts_as_shift ? "counts as a worked shift" : "on call only (not counted toward shifts or hours)",
    r.min_per_person ? `at least ${r.min_per_person} per person where possible` : null,
    r.max_per_person != null ? `at most ${r.max_per_person} per person` : "no limit per person",
    r.min_days_between ? `at least ${r.min_days_between} day${r.min_days_between === 1 ? "" : "s"} between one person's backups` : null,
    r.rest_before_hours ? `${r.rest_before_hours}h free before` : null,
    r.rest_after_hours ? `${r.rest_after_hours}h free after` : null,
    r.not_after_night ? "not the day after a night shift" : null,
    r.not_before_night ? "not the day before a night shift" : null,
    r.not_next_to_vacation ? "not next to vacation" : null,
    "spread as evenly as possible",
  ];
  return parts.filter(Boolean).join("; ");
}
