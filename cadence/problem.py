"""Problem definition for one scheduling block.

NOTHING about the program is decided here. Shift start times, shift lengths,
headcounts, academic time, chief time, category names and every rule limit are
read from an admin-supplied configuration (a plain dict / JSON file).

Internally all times are whole minutes from 00:00 on day 0 of the block;
negative values are the tail of the previous block ("history").
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from datetime import date, timedelta

DAY = 1440


def to_min(v) -> int:
    """'07:30' -> 450 ; 7.5 -> 450 (hours)."""
    if isinstance(v, str):
        h, m = v.split(":")
        return int(h) * 60 + int(m)
    return int(round(float(v) * 60))


def clock(m: int) -> str:
    return f"{(m % DAY) // 60:02d}:{m % 60:02d}"


@dataclass
class Shift:
    """One staffed shift type on one date (needs `need` residents), or one
    already-worked shift from the previous block (hist=True)."""
    key: tuple
    name: str
    day: int
    start: int
    end: int
    cat: str
    site: str = ""
    pod: str = ""
    min_pgy: int = 1
    need: int = 1            # people it must have (the minimum headcount); unfilled = an open shift
    hist: bool = False
    ref: str = ""            # id of the shift template this came from (for per-person eligibility)
    cap: int = 0             # most people it may have (the maximum headcount); places above `need` are optional

    def __post_init__(self):
        self.cap = max(self.cap, self.need)

    @property
    def dur(self) -> int:
        return self.end - self.start

    @property
    def cal(self) -> int:
        """Calendar day the shift actually starts on. `day` is the day it BELONGS to:
        a night that starts just after midnight belongs to the previous day, so a run
        of nights is one shift per day even when two of them start on the same date."""
        return self.start // DAY


@dataclass
class Resident:
    id: str
    name: str
    pgy: int
    shifts_min: int
    shifts_max: int
    chief_days: bool = False
    vacation: set = field(default_factory=set)
    mandatory_off: set = field(default_factory=set)
    requests_off: dict = field(default_factory=dict)   # day -> weight (soft)
    sites: tuple | None = None                          # None = any site
    unavailable: list = field(default_factory=list)     # hard "cannot work" rules, see Problem._unavailable
    only_refs: frozenset | None = None                  # if set, the only shift templates this person may work
    site_share: dict = field(default_factory=dict)     # site -> target % of this person's shifts (soft, see "site split")
    max_consecutive_days: int | None = None             # personal limit on days worked in a row (else the program's)


@dataclass
class Academic:
    name: str
    day: int
    start: int
    end: int
    block_from: int      # no shift may overlap [block_from, block_to)
    block_to: int
    pgy: tuple | None    # which PGY levels attend (None = everyone)
    policy: str = "blocked"   # what happens to a shift that overlaps: "blocked" or "excused"
    excused: frozenset = frozenset()   # resident ids who do not attend although their level does
    also: frozenset = frozenset()      # resident ids who attend although their level does not


@dataclass
class Rules:
    max_week_minutes: int = 3600            # clinical minutes in any rolling 7 days
    rest_ratio: float = 1.0                 # rest after a shift >= ratio x its length
    min_rest_minutes: int = 0               # ... and never less than this
    max_nights: int = 8
    max_night_runs: int = 2
    min_gap_between_night_runs: int = 7     # soft
    max_night_fraction_pct: int = 45        # soft
    soft_max_nights_in_run: int = 6         # soft
    balance_tolerance_shifts: float = 1.0   # day/evening/night counts within this of fair share are "balanced"
    pod_tolerance_shifts: int = 1           # |pod A - pod B| up to this is "balanced"
    site_share_tolerance_shifts: int = 1    # within this many shifts of a person's target split between sites is "met"
    max_consecutive_days: int | None = 6    # hard: days worked in a row (a shift counts on the day it belongs to); None/0 = no limit
    history_days: int = 7


class Problem:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.name = cfg.get("name", "block")
        self.start_date = date.fromisoformat(cfg["start_date"])
        self.n_days = int(cfg["n_days"])
        rc = dict(cfg.get("rules", {}))
        if "max_week_hours" in rc:
            rc["max_week_minutes"] = to_min(rc.pop("max_week_hours"))
        if "min_rest_hours" in rc:
            rc["min_rest_minutes"] = to_min(rc.pop("min_rest_hours"))
        self.rules = Rules(**rc)
        H = self.rules.history_days

        self.cat_order = {c: i for i, c in enumerate(cfg["category_order"])}
        self.night_cats = set(cfg.get("night_categories", []))
        self.balance_group = cfg.get("balance_groups") or {c: c for c in self.cat_order}
        self.pod_pairs = [tuple(p) for p in cfg.get("pod_pairs", [])]

        self.residents = [Resident(
            id=r["id"], name=r.get("name", r["id"]), pgy=int(r["pgy"]),
            shifts_min=int(r["shifts_min"]), shifts_max=int(r["shifts_max"]),
            chief_days=bool(r.get("chief_days", False)),
            vacation=set(r.get("vacation", [])), mandatory_off=set(r.get("mandatory_off", [])),
            requests_off={int(k): int(v) for k, v in r.get("requests_off", {}).items()},
            sites=tuple(r["sites"]) if r.get("sites") else None,
            only_refs=frozenset(r["only_shifts"]) if r.get("only_shifts") is not None else None,
            site_share={k: int(v) for k, v in (r.get("site_share") or {}).items()},
            max_consecutive_days=int(r["max_consecutive_days"]) if r.get("max_consecutive_days") else None,
            unavailable=[dict(u, start_min=to_min(u["start"]) if u.get("start") is not None else None,
                              dur_min=to_min(u.get("hours", 24))) for u in r.get("unavailable", [])])
            for r in cfg["residents"]]
        self.by_id = {r.id: r for r in self.residents}
        for r in self.residents:
            assert self.max_run(r) is None or self.max_run(r) >= 1, f"{r.id}: max_consecutive_days must be at least 1"

        # ---- shift templates expanded onto dates --------------------------------
        self.templates = cfg["shift_templates"]
        self.slots = {}
        for k, t in enumerate(self.templates):
            st, dur = to_min(t["start"]), to_min(t["hours"])
            assert t["category"] in self.cat_order, f"unknown category {t['category']}"
            # A night that starts after midnight counts as the previous day's night
            # (admin can set this explicitly per template).
            prev = bool(t.get("counts_as_previous_day", t["category"] in self.night_cats and st < 720))
            for d in range(self.n_days):
                if "only_days" in t:
                    if d not in t["only_days"]:
                        continue
                elif self.weekday(d) not in t.get("weekdays", range(7)) or d in t.get("except_days", ()):
                    continue
                need = max(0, int(t.get("headcount", 1)))
                cap = max(need, int(t.get("max_headcount") or need))      # optional places above the minimum
                if cap <= 0:
                    continue
                base = (d + prev) * DAY + st
                self.slots[(d, k)] = Shift((d, k), t["name"], d, base, base + dur,
                                           t["category"], t.get("site", ""), t.get("pod", ""),
                                           int(t.get("min_pgy", 1)), need,
                                           ref=str(t.get("ref", t["name"])), cap=cap)
        self.slot_list = sorted(self.slots.values(), key=lambda s: (s.day, s.start, s.key))

        # ---- academic (protected educational) time ------------------------------
        # Admin setting, per session (or one program-wide default): if a shift overlaps the
        # session, is the resident "blocked" from that shift, or "excused" from the session?
        self.academic = []
        default = cfg.get("academic_if_shift_overlaps", "blocked")
        for a in cfg.get("academic_time", []):
            s = a["day"] * DAY + to_min(a["start"])
            e = s + to_min(a["hours"])
            policy = a.get("if_shift_overlaps", default)
            assert policy in ("blocked", "excused"), f"academic_time.if_shift_overlaps: unknown value {policy!r}"
            self.academic.append(Academic(a.get("name", "Academic time"), a["day"], s, e,
                                          s - to_min(a.get("protect_before_hours", 0)),
                                          e + to_min(a.get("protect_after_hours", 0)),
                                          tuple(a["pgy"]) if a.get("pgy") else None, policy,
                                          frozenset(a.get("excused", ())), frozenset(a.get("also_attend", ()))))

        # ---- chief time: weekly windows chiefs cannot be scheduled in -----------
        self.chief_windows = []
        for c in cfg.get("chief_time", []):
            for d in range(-H - 1, self.n_days + 1):
                if self.weekday(d) == c["weekday"]:
                    s = d * DAY + to_min(c["start"])
                    self.chief_windows.append((s, s + to_min(c["hours"])))

        # ---- history: shifts already worked at the end of the previous block ----
        self.hist = {r.id: [] for r in self.residents}
        for i, h in enumerate(cfg.get("history", [])):
            s = h["day"] * DAY + to_min(h["start"])
            prev = bool(h.get("counts_as_previous_day", h["category"] in self.night_cats and to_min(h["start"]) < 720))
            self.hist[h["resident"]].append(
                Shift(("H", h["resident"], i), h.get("name", "prior block"), h["day"] - prev, s,
                      s + to_min(h["hours"]), h["category"], hist=True))

    # ---- helpers ---------------------------------------------------------------
    @classmethod
    def load(cls, path):
        return cls(json.load(open(path)))

    def weekday(self, d: int) -> int:
        return (self.start_date + timedelta(days=d)).weekday()

    def date(self, d: int):
        return self.start_date + timedelta(days=d)

    def label(self, d: int) -> str:
        return self.date(d).strftime("%a %m/%d")

    def max_run(self, r):
        """Most days in a row this person may work (None = no limit)."""
        return r.max_consecutive_days or self.rules.max_consecutive_days or None

    def is_night(self, s: Shift) -> bool:
        return s.cat in self.night_cats

    def rest_after(self, s: Shift) -> int:
        return max(int(-(-s.dur * self.rules.rest_ratio // 1)), self.rules.min_rest_minutes)

    def attends(self, r: Resident, a: Academic) -> bool:
        if r.id in a.excused or a.day in r.vacation:
            return False
        return a.pgy is None or r.pgy in a.pgy or r.id in a.also

    def _unavailable(self, u: dict, s: Shift) -> bool:
        """Does hard rule u stop its resident working shift s? A rule can limit by date
        range, weekdays, a time-of-day window, shift categories and sites; whatever it
        leaves out matches everything."""
        if u.get("categories") and s.cat not in u["categories"]:
            return False
        if u.get("sites") and s.site not in u["sites"]:
            return False
        lo, hi, wd = u.get("from_day"), u.get("to_day"), u.get("weekdays")
        if u.get("start_min") is None:
            return not ((lo is not None and s.cal < lo) or (hi is not None and s.cal > hi)
                        or (wd is not None and self.weekday(s.cal) not in wd))
        for d in range(s.cal - 1, (s.end - 1) // DAY + 1):       # a window on any of these dates could overlap
            if (lo is not None and d < lo) or (hi is not None and d > hi) or (wd is not None and self.weekday(d) not in wd):
                continue
            w0 = d * DAY + u["start_min"]
            if s.start < w0 + u["dur_min"] and w0 < s.end:
                return True
        return False

    def static_block_reason(self, r: Resident, s: Shift):
        """Why r can never take s, whatever the rest of the schedule looks like."""
        if r.pgy < s.min_pgy:
            return f"needs PGY-{s.min_pgy}+"
        if r.sites is not None and s.site not in r.sites:
            return "not assigned to site"
        if r.only_refs is not None and s.ref not in r.only_refs:
            return "not eligible for this shift"
        if s.cal in r.vacation:
            return "vacation"
        if s.cal in r.mandatory_off:
            return "mandatory request off"
        if r.chief_days and any(s.start < b and a < s.end for a, b in self.chief_windows):
            return "chief time"
        for u in r.unavailable:
            if self._unavailable(u, s):
                return u.get("label") or "unavailable (rule)"
        if any(a.policy == "blocked" and self.attends(r, a) and s.start < a.block_to and a.block_from < s.end
               for a in self.academic):
            return "academic time"
        return None

    def balance_share(self):
        """Fair share (x10) of each balance group per resident, proportional to contract size."""
        tot = sum(r.shifts_max for r in self.residents)
        n = {}
        for s in self.slot_list:
            g = self.balance_group[s.cat]
            n[g] = n.get(g, 0) + s.need
        return {(r.id, g): int(round(10 * n[g] * r.shifts_max / tot)) for r in self.residents for g in n}


# Optimisation goals in strict priority order. The first two are the "never come
# back empty" slacks; the rest are the soft goals from the spec.
STAGES = ["open shifts", "contract shortfall", "extra places used", "site split", "backward rotations", "day/evening/night balance",
          "night runs too close", "nights into vacation", "night share over limit", "pod balance",
          "isolated days off", "extra / over-long night runs", "requests off missed"]
# goals that live on the coverage rows rather than on one resident: places left open below a shift's minimum
# headcount, and optional places used above it (kept to what the goals above need: reaching contract minimums)
COVER_STAGES = ("open shifts", "extra places used")
