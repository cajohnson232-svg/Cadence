"""Independent, plain-code schedule checker.

Shares NO code with the optimisation model: every ACGME and program rule is
re-derived from the finished schedule with simple loops over actual clock
times, so a modelling bug in the solver cannot hide here.

    assignment: {resident_id: [slot_key, ...]}
"""
from __future__ import annotations
from math import gcd
from .problem import Problem, Resident, DAY, clock

WEEK = 7 * DAY


def worked(P: Problem, r: Resident, assignment):
    return sorted(P.hist[r.id] + [P.slots[k] for k in assignment.get(r.id, ())], key=lambda s: s.start)


def longest_break(duty, lo, hi):
    """Longest stretch in [lo, hi) not covered by any (start, end) in duty (sorted by start)."""
    best, cursor = 0, lo
    for a, b in duty:
        if b <= lo or a >= hi:
            continue
        best = max(best, a - cursor)
        cursor = max(cursor, b)
    return max(best, hi - cursor)


def past_broken_weeks(P: Problem, r: Resident):
    """First days (before day 0) of the 7-day windows that the previous block's shifts and academic
    time already leave without 24h free of duty, whatever this block does."""
    past = P.hist[r.id]
    base = sorted([(s.start, s.end) for s in past] + [
        (a.start, a.end) for a in P.academic if a.day not in r.vacation and r.id not in a.excused
        and (a.pgy is None or r.pgy in a.pgy or r.id in a.also)
        and (a.policy == "blocked" or not any(s.start < a.block_to and a.block_from < s.end for s in past))])
    return [d for d in range(-(P.rules.history_days - 1), 0) if longest_break(base, d * DAY, d * DAY + WEEK) < DAY]


def check_resident(P: Problem, r: Resident, shifts, check_min=True):
    """Hard-rule violations for one resident, given every shift they work
    (previous-block shifts included). Returns plain-English strings."""
    V, R = [], P.rules
    shifts = sorted(shifts, key=lambda s: s.start)
    cur = [s for s in shifts if not s.hist]
    sessions = [a for a in P.academic if a.day not in r.vacation and r.id not in a.excused
                and (a.pgy is None or r.pgy in a.pgy or r.id in a.also)]

    for s in cur:
        tag = f"{s.name} {P.label(s.cal)}"
        if r.pgy < s.min_pgy:
            V.append(f"{tag}: requires PGY-{s.min_pgy}+")
        if r.sites is not None and s.site not in r.sites:
            V.append(f"{tag}: not assigned to {s.site}")
        if r.only_refs is not None and s.ref not in r.only_refs:
            V.append(f"{tag}: not eligible for this shift")
        if s.cal in r.vacation:
            V.append(f"{tag}: scheduled on vacation")
        if s.cal in r.mandatory_off:
            V.append(f"{tag}: scheduled on a mandatory day off")
        if r.chief_days and any(s.start < b and a < s.end for a, b in P.chief_windows):
            V.append(f"{tag}: overlaps chief time")
        for u in r.unavailable:                      # personal "cannot work" rules, checked from scratch
            if (u.get("categories") and s.cat not in u["categories"]) or (u.get("sites") and s.site not in u["sites"]):
                continue
            first = s.start // DAY
            dates = [first] if u.get("start_min") is None else range(first - 1, (s.end - 1) // DAY + 1)
            for d in dates:
                if u.get("from_day") is not None and d < u["from_day"] or u.get("to_day") is not None and d > u["to_day"]:
                    continue
                if u.get("weekdays") is not None and P.weekday(d) not in u["weekdays"]:
                    continue
                if u.get("start_min") is None or (s.start < d * DAY + u["start_min"] + u["dur_min"]
                                                  and d * DAY + u["start_min"] < s.end):
                    V.append(f"{tag}: {u.get('label') or 'unavailable (rule)'}")
                    break
        if any(a.policy == "blocked" and s.start < a.block_to and a.block_from < s.end for a in sessions):
            V.append(f"{tag}: overlaps protected academic time")

    # One shift per day. A shift counts toward the day it belongs to (s.day), so back-to-back
    # nights are one per day even when one starts just after midnight and the next starts late
    # that same evening.
    per_day = {}
    for s in shifts:
        per_day.setdefault(s.day, []).append(s)
    for d, group in per_day.items():
        if len(group) > 1 and any(not s.hist for s in group):
            V.append(f"two shifts on {P.label(d)}")
    # days worked in a row (a day counts when a shift belongs to it; the previous block's last week counts too)
    L = P.max_run(r)
    if L:
        worked_days, cur_days = sorted(per_day), {s.day for s in cur}
        run = []
        for d in worked_days + [None]:
            if run and (d is None or d != run[-1] + 1):
                if len(run) > L and cur_days & set(run):
                    V.append(f"{len(run)} days worked in a row, {P.label(run[0])} to {P.label(run[-1])} (limit {L})")
                run = []
            if d is not None:
                run.append(d)
    # rest after a shift >= (ratio x) its own length
    for a, b in zip(shifts, shifts[1:]):
        if b.hist or a.day == b.day:
            continue
        need = max(-(-a.dur * R.rest_ratio // 1), R.min_rest_minutes)
        if b.start - a.end < need:
            V.append(f"only {(b.start - a.end) / 60:g}h rest after the {a.dur / 60:g}h shift on {P.label(a.cal)}")

    # clinical time in ANY rolling 7x24h window. Where the previous block's shifts alone already pass the
    # limit, nothing in this block can undo that: the window may not get any more, but is not counted broken.
    past = [s for s in shifts if s.hist]
    worst = (0, 0, 0)
    for t in sorted({s.start for s in shifts} | {s.end - WEEK for s in shifts}):
        if t + WEEK <= 0 or t < -R.history_days * DAY:
            continue
        mins = sum(max(0, min(s.end, t + WEEK) - max(s.start, t)) for s in shifts)
        limit = max(R.max_week_minutes, sum(max(0, min(s.end, t + WEEK) - max(s.start, t)) for s in past))
        if mins - limit > worst[0] - worst[2]:
            worst = (mins, t, limit)
    if worst[0] > worst[2]:
        extra = f"; {worst[2] / 60:g}h already worked before this interval" if worst[2] > R.max_week_minutes else ""
        V.append(f"{worst[0] / 60:g}h in the 7 days from {P.label(worst[1] // DAY)} {clock(worst[1])} "
                 f"(limit {R.max_week_minutes / 60:g}h{extra})")

    # one continuous 24h free of all duty (shifts + academic time) in every 7 days
    # (a resident working a shift across an "excused" session does not attend it)
    attended = [(a.start, a.end) for a in sessions
                if a.policy == "blocked" or not any(s.start < a.block_to and a.block_from < s.end for s in shifts)]
    duty = sorted([(s.start, s.end) for s in shifts] + attended)
    # the same with nothing worked in this block: a week that the previous block's shifts (and academic
    # time) already leave without a 24h break cannot be fixed now, so it is not counted against this block
    base = sorted([(s.start, s.end) for s in past] + [(a.start, a.end) for a in sessions if a.policy == "blocked"
                  or not any(s.start < a.block_to and a.block_from < s.end for s in past)])
    for d in range(-(R.history_days - 1), P.n_days - 6):
        best = longest_break(duty, d * DAY, d * DAY + WEEK)
        if best < DAY and not (d < 0 and longest_break(base, d * DAY, d * DAY + WEEK) < DAY):
            V.append(f"no 24h free of duty in the 7 days from {P.label(d)} (longest break {best / 60:g}h)")

    # nights
    night_days = {s.day for s in shifts if s.cat in P.night_cats}
    n_cur = sum(1 for s in cur if s.cat in P.night_cats)
    if n_cur > R.max_nights:
        V.append(f"{n_cur} night shifts (limit {R.max_nights})")
    runs = sum(1 for d in night_days if d >= 0 and d - 1 not in night_days)
    if runs > R.max_night_runs:
        V.append(f"{runs} separate runs of nights (limit {R.max_night_runs})")

    if len(cur) > r.shifts_max:
        V.append(f"{len(cur)} shifts (contract maximum {r.shifts_max})")
    if check_min and len(cur) < r.shifts_min:
        V.append(f"{len(cur)} shifts (contract minimum {r.shifts_min})")
    return V


def validate(P: Problem, assignment):
    """Returns (hard violations, open slots [(shift, n_missing)], contract shortfalls)."""
    V, short = [], []
    filled = {}
    for rid, keys in assignment.items():
        if rid not in P.by_id:
            V.append(f"unknown resident {rid}")
        if len(set(keys)) != len(keys):
            V.append(f"{rid}: same shift assigned twice")
        for k in keys:
            filled[k] = filled.get(k, 0) + 1
    open_slots = []
    for s in P.slot_list:
        f = filled.get(s.key, 0)
        if f > s.cap:
            V.append(f"{s.name} {P.label(s.cal)}: {f} residents assigned, at most {s.cap} allowed")
        elif f < s.need:
            open_slots.append((s, s.need - f))
    for r in P.residents:
        for v in check_resident(P, r, worked(P, r, assignment)):
            (short if "contract minimum" in v else V).append(f"{r.name}: {v}")
    return V, open_slots, short


def _pod_pairs_for(P, r, _cache={}):
    key = (id(P), r.id)
    if key not in _cache:
        _cache[key] = [(site, a, b) for site, a, b in P.pod_pairs
                       if all(any(s.site == site and s.pod == p and r.pgy >= s.min_pgy and (r.sites is None or site in r.sites)
                                  and (r.only_refs is None or s.ref in r.only_refs)
                                  for s in P.slot_list) for p in (a, b))]
    return _cache[key]


def soft_resident(P: Problem, r: Resident, shifts, share):
    """Soft-goal scores for one resident, recomputed from scratch (lower is better)."""
    R = P.rules
    cur = [s for s in shifts if not s.hist]
    byday = {s.day: s for s in shifts}
    nights = {d for d, s in byday.items() if s.cat in P.night_cats}
    M = {}
    M["contract shortfall"] = max(0, r.shifts_min - len(cur))
    M["backward rotations"] = sum(
        1 for d in range(-1, P.n_days - 1)
        if d in byday and d + 1 in byday and P.cat_order[byday[d + 1].cat] < P.cat_order[byday[d].cat])
    tol = int(round(10 * R.balance_tolerance_shifts))
    M["day/evening/night balance"] = sum(
        max(0, abs(10 * sum(P.balance_group[s.cat] == g for s in cur) - sh) - tol)
        for g, sh in ((g, share[r.id, g]) for g in sorted(set(P.balance_group.values())) if (r.id, g) in share))
    starts = [d for d in nights if d >= 0 and d - 1 not in nights]
    M["night runs too close"] = sum(
        1 for d in starts if any(e in nights for e in range(d - R.min_gap_between_night_runs, d - 1)))
    M["nights into vacation"] = sum(1 for s in cur if s.end > (s.cal + 1) * DAY and s.cal + 1 in r.vacation)
    nm, tm = sum(s.dur for s in cur if s.cat in P.night_cats), sum(s.dur for s in cur)
    g = gcd(100, R.max_night_fraction_pct)
    M["night share over limit"] = max(0, (100 * nm - R.max_night_fraction_pct * tm) // g)
    M["pod balance"] = 0
    for site, a, b in _pod_pairs_for(P, r):
        if True:
            M["pod balance"] += max(0, abs(sum(s.site == site and s.pod == a for s in cur)
                                           - sum(s.site == site and s.pod == b for s in cur)) - R.pod_tolerance_shifts)
    tol = 100 * R.site_share_tolerance_shifts      # site split, in hundredths of a shift
    M["site split"] = sum(max(0, abs(100 * sum(s.site == site for s in cur) - pct * len(cur)) - tol)
                          for site, pct in r.site_share.items())
    M["isolated days off"] = sum(1 for d in range(0, P.n_days - 1)
                                 if d not in byday and d - 1 in byday and d + 1 in byday)
    k = R.soft_max_nights_in_run + 1
    M["extra / over-long night runs"] = max(0, len(starts) - 1) + sum(
        1 for d in range(-(k - 1), P.n_days - k + 1) if all(e in nights for e in range(d, d + k)))
    M["requests off missed"] = sum(r.requests_off.get(s.cal, 0) for s in cur)   # by calendar date of the shift
    return M


def soft_metrics(P: Problem, assignment):
    share = P.balance_share()
    tot = {}
    for r in P.residents:
        for k, v in soft_resident(P, r, worked(P, r, assignment), share).items():
            tot[k] = tot.get(k, 0) + v
    tot["extra places used"] = extra_places(P, assignment)
    return tot


def duty_stats(P: Problem, assignment):
    """Headline duty-hour figures across all residents, straight from the clock times."""
    peak = 0
    tight_rest = None
    for r in P.residents:
        shifts = worked(P, r, assignment)
        for t in {s.start for s in shifts} | {s.end - WEEK for s in shifts}:
            if t + WEEK <= 0 or t < -P.rules.history_days * DAY:
                continue
            peak = max(peak, sum(max(0, min(s.end, t + WEEK) - max(s.start, t)) for s in shifts))
        for a, b in zip(shifts, shifts[1:]):
            if not b.hist:
                slack = (b.start - a.end) - a.dur
                tight_rest = slack if tight_rest is None else min(tight_rest, slack)
    return {"peak_rolling_7day_hours": peak / 60, "smallest_rest_margin_hours": (tight_rest or 0) / 60}


def extra_places(P: Problem, assignment):
    """Optional places used: people on a shift beyond its minimum headcount (never beyond its maximum)."""
    filled = {}
    for keys in assignment.values():
        for k in keys:
            filled[k] = filled.get(k, 0) + 1
    return sum(max(0, filled.get(s.key, 0) - s.need) for s in P.slot_list)
