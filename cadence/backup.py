"""Backup (on-call) shifts.

A backup shift is someone at home, ready to come in. It is assigned AFTER the clinical schedule is
final, one exact optimisation for the whole interval, and changes nothing in the clinical schedule.
By default it is not a worked shift: it does not count toward anyone's shift total or clinical hours.
(A program that wants backup to count as a shift has it compiled as an ordinary shift instead, and
this module is not used.)

Configuration, in the engine input:

    "backup": [{
        "name": "Backup", "ref": "<shift id>", "site": "LBJ", "category": "Day",
        "start": "07:00", "hours": 24, "weekdays": [0, ..., 6], "headcount": 1,
        "eligible": ["<resident id>", ...] or null (everyone),
        "rules": {"max_per_person": 4 or null, "min_days_between": 0,
                  "rest_before_hours": 0, "rest_after_hours": 0}
    }]

Hard rules (never broken; a day nobody can take is left open, with reasons):
  * only eligible people; never on vacation, a mandatory day off, required time off or any other
    personal "cannot work" rule, or in chief time;
  * not while on a clinical shift, with the configured rest before and after;
  * one backup per person per day, at most max_per_person in the interval, and at least
    min_days_between days between two of one person's backups;
  * a person's weekly 24 hours free stay free of backup too (ACGME: at-home call is not assigned on
    the free day), in every 7 days, counting the end of the previous block.
Goals, in order: fill every backup day; spread backups as evenly as possible (smallest maximum per
person); avoid days people asked to have off.
"""
from __future__ import annotations
from collections import defaultdict
import numpy as np
from scipy import sparse
from scipy.optimize import Bounds, LinearConstraint, milp
from .problem import Problem, Shift, DAY, to_min
from . import validator

WEEK = 7 * DAY


class Line:
    def __init__(self, k, b):
        self.k, self.name, self.ref = k, b.get("name", "Backup"), str(b.get("ref", b.get("name", "Backup")))
        self.site, self.cat = b.get("site", ""), b.get("category", "")
        self.start, self.dur = to_min(b.get("start", "07:00")), to_min(b.get("hours", 24))
        self.weekdays = set(b.get("weekdays", range(7)))
        self.only_days = set(b["only_days"]) if b.get("only_days") is not None else None
        self.need = int(b.get("headcount", 1))
        self.eligible = set(b["eligible"]) if b.get("eligible") is not None else None
        r = b.get("rules") or {}
        self.max_per_person = r.get("max_per_person")
        self.min_between = int(r.get("min_days_between") or 0)
        self.rest_before = to_min(r.get("rest_before_hours") or 0)
        self.rest_after = to_min(r.get("rest_after_hours") or 0)
        self.not_after_night = bool(r.get("not_after_night"))          # not the day after a night shift
        self.not_before_night = bool(r.get("not_before_night"))        # not the day before a night shift
        self.not_next_to_vacation = bool(r.get("not_next_to_vacation"))  # not the day before vacation starts or after it ends
        self.min_per_person = int(r["min_per_person"]) if r.get("min_per_person") else 0   # aimed for: everyone eligible gets this many

    def runs(self, P, d):
        return d in self.only_days if self.only_days is not None else P.weekday(d) in self.weekdays

    def window(self, d):
        s = d * DAY + self.start
        return s, s + self.dur


def lines(P: Problem):
    return [Line(k, b) for k, b in enumerate(P.cfg.get("backup") or [])]


def _sessions(P, r, shifts):
    """Academic sessions r actually attends (as the validator counts them for the 24h-free rule)."""
    att = [a for a in P.academic if a.day not in r.vacation and r.id not in a.excused
           and (a.pgy is None or r.pgy in a.pgy or r.id in a.also)]
    return [(a.start, a.end) for a in att
            if a.policy == "blocked" or not any(s.start < a.block_to and a.block_from < s.end for s in shifts)]


def static_reason(P: Problem, L: Line, r, d, shifts):
    """Why r cannot be on backup line L on day d, whatever other backups are chosen (None = can)."""
    if L.eligible is not None and r.id not in L.eligible:
        return "not eligible for backup"
    if d in r.vacation:
        return "vacation"
    if d in r.mandatory_off:
        return "mandatory day off"
    a, b = L.window(d)
    pseudo = Shift(("B", L.k, d), L.name, d, a, b, L.cat, "", "", 1, 1)       # site "" : site limits do not apply to backup
    if r.chief_days and any(a < y and x < b for x, y in P.chief_windows):
        return "chief time"
    for u in r.unavailable:
        if P._unavailable(u, pseudo):
            return u.get("label") or "unavailable (rule)"
    for s in shifts:
        if s.start < b + L.rest_after and a - L.rest_before < s.end:
            return "working a shift then" if (s.start < b and a < s.end) else "not enough rest around a shift"
    if L.not_after_night and any(P.is_night(s) and s.day == d - 1 for s in shifts):
        return "the day after a night shift"
    if L.not_before_night and any(P.is_night(s) and s.day == d + 1 for s in shifts):
        return "the day before a night shift"
    if L.not_next_to_vacation and (d - 1 in r.vacation or d + 1 in r.vacation):
        return "next to vacation"
    return None


def _free_windows(P, r, shifts, cands):
    """Every 7-day window's candidate 24h free stretches, given the clinical schedule.
    A free 24h stretch can always be slid left until it starts at the start of a free gap or at the end of a
    backup window, so those starting points are enough. Returns [(window_day, [(t0, t1), ...]), ...]."""
    H = P.rules.history_days
    duty = sorted([(s.start, s.end) for s in shifts] + _sessions(P, r, shifts))
    ends = sorted({be for (_, _, (_, be)) in cands})
    out = []
    for w in range(-(H - 1), P.n_days - 6):
        lo, hi = w * DAY, w * DAY + WEEK
        gaps, cursor = [], lo
        for a, b in duty:
            if b <= lo or a >= hi:
                continue
            if a > cursor:
                gaps.append((cursor, a))
            cursor = max(cursor, b)
        if cursor < hi:
            gaps.append((cursor, hi))
        free = []
        for g0, g1 in gaps:
            for t in [g0] + [e for e in ends if g0 < e < g1]:
                if t + DAY <= g1:
                    free.append((t, t + DAY))
        out.append((w, free))
    return out


def assign(P: Problem, assignment, seconds=30.0):
    """Choose who is on backup each day. Returns a JSON-able result (see report.result)."""
    L = lines(P)
    if not L:
        return None
    R = P.residents
    work = {r.id: validator.worked(P, r, assignment) for r in R}
    cands, why = [], {}                   # cands: (line, resident, day) ; why[(line, day)] = {reason: [names]}
    for l in L:
        for d in range(P.n_days):
            if not l.runs(P, d) or l.need <= 0:
                continue
            why[(l.k, d)] = defaultdict(list)
            for r in R:
                reason = static_reason(P, l, r, d, work[r.id])
                if reason:
                    why[(l.k, d)][reason].append(r.name)
                else:
                    cands.append((l, r, (d, l.window(d))))
    days = [(l, d) for l in L for d in range(P.n_days) if l.runs(P, d) and l.need > 0]
    nb, no = len(cands), len(days)
    var = {}                                    # name -> index
    for i, (l, r, (d, _)) in enumerate(cands):
        var[("b", l.k, r.id, d)] = i
    for j, (l, d) in enumerate(days):
        var[("o", l.k, d)] = nb + j
    n = nb + no
    rows, lo, hi = [], [], []

    def row(terms, a, b):
        rows.append(terms); lo.append(a); hi.append(b)

    for l, d in days:                           # cover each backup day, or leave it open
        row([(var[("b", l.k, r.id, e)], 1) for (ll, r, (e, _)) in cands if ll is l and e == d] + [(var[("o", l.k, d)], 1)], l.need, l.need)
    byr = defaultdict(list)
    for i, (l, r, (d, win)) in enumerate(cands):
        byr[r.id].append((i, l, d, win))
    ys = []
    for r in R:
        mine = byr.get(r.id, [])
        if not mine:
            continue
        perday = defaultdict(list)
        for i, l, d, _ in mine:
            perday[d].append(i)
        for d, ii in perday.items():            # one backup a day
            if len(ii) > 1:
                row([(i, 1) for i in ii], 0, 1)
        for l in L:
            mine_l = [(i, d) for i, ll, d, _ in mine if ll is l]
            if l.max_per_person is not None and mine_l:
                row([(i, 1) for i, _ in mine_l], 0, int(l.max_per_person))
        gap = max((l.min_between for l in L), default=0)
        if gap > 0:                             # at least min_days_between days between backups
            for d in range(P.n_days):
                ii = [i for i, _, e, _ in mine if d <= e <= d + gap]
                if len(ii) > 1:
                    row([(i, 1) for i in ii], 0, 1)
        # the weekly 24h free stays free of backup
        for w, free in _free_windows(P, r, work[r.id], [(i, d, win) for i, _, d, win in mine]):
            if not free:
                continue                        # the clinical schedule already has no 24h break here; nothing backup can change
            hits = [[i for i, _, _, (a, b) in mine if a < t1 and t0 < b] for t0, t1 in free]
            if any(not h for h in hits):
                continue                        # some free stretch can never be touched by backup: always kept
            yv = []
            for (t0, t1), h in zip(free, hits):
                y = n + len(ys); ys.append(y); yv.append(y)
                for i in h:
                    row([(y, 1), (i, 1)], 0, 1)
            row([(y, 1) for y in yv], 1, np.inf)
    n += len(ys)
    lows = []                                   # aimed-for minimum per person: a shortfall costs less than an open day
    for l in L:
        if not l.min_per_person:
            continue
        for r in R:
            if l.eligible is not None and r.id not in l.eligible:
                continue
            mine_l = [i for i, ll, _, _ in byr.get(r.id, []) if ll is l]
            row([(i, 1) for i in mine_l] + [(n + len(lows), 1)], l.min_per_person, np.inf)
            lows.append((l, r))
    n += len(lows)
    z = n; n += 1                               # most backups for any one person
    for rid, mine in byr.items():
        row([(i, 1) for i, *_ in mine] + [(z, -1)], -np.inf, 0)
    c = np.zeros(n)
    c[nb:nb + no] = 10000.0
    c[z] = 100.0
    c[z - len(lows):z] = 1000.0
    for i, (l, r, (d, _)) in enumerate(cands):
        c[i] = 0.01 + 3.0 * r.requests_off.get(d, 0)
    data, ri, ci = [], [], []
    for k, terms in enumerate(rows):
        for v, a in terms:
            ri.append(k); ci.append(v); data.append(a)
    A = sparse.csr_matrix((data, (ri, ci)), shape=(len(rows), n))
    ub = np.ones(n); ub[nb:nb + no] = [l.need for l, _ in days]; ub[z] = P.n_days
    for j, (l, _) in enumerate(lows):
        ub[z - len(lows) + j] = l.min_per_person
    res = milp(c, constraints=LinearConstraint(A, lo, hi) if rows else None, integrality=np.ones(n),
               bounds=Bounds(np.zeros(n), ub), options={"time_limit": seconds})
    x = np.round(res.x) if res.x is not None else np.zeros(n)
    chosen = [(l, r, d) for i, (l, r, (d, _)) in enumerate(cands) if x[i] > 0.5]
    status = "optimal" if res.status == 0 else ("best found" if res.x is not None else "not solved")
    out_days, opens = [], []
    for l, d in days:
        who = [r.id for ll, r, e in chosen if ll is l and e == d]
        a, b = l.window(d)
        out_days.append({"line": l.k, "name": l.name, "ref": l.ref, "site": l.site, "category": l.cat, "day": d,
                         "start": a, "end": b, "need": l.need, "assigned": sorted(who)})
        if len(who) < l.need:
            reasons = dict(why[(l.k, d)])
            for ll, r, (e, _) in cands:
                if ll is l and e == d and r.id not in who:
                    reasons.setdefault("would break a backup rule (maximum, spacing, or their weekly 24h off)", []).append(r.name)
            opens.append({"line": l.k, "name": l.name, "day": d, "start": a, "end": b, "need": l.need, "missing": l.need - len(who),
                          "reasons": [{"reason": k, "count": len(v), "names": v} for k, v in sorted(reasons.items(), key=lambda kv: -len(kv[1]))]})
    load = defaultdict(int)
    for _, r, _ in chosen:
        load[r.id] += 1
    below = [{"resident": r.id, "name": r.name, "line": l.name, "has": sum(1 for ll, rr, _ in chosen if ll is l and rr is r), "minimum": l.min_per_person}
             for l, r in lows if sum(1 for ll, rr, _ in chosen if ll is l and rr is r) < l.min_per_person]
    return {"days": out_days, "open": opens, "per_resident": dict(load), "status": status, "below_minimum": below,
            "requests_off_used": sum(1 for _, r, d in chosen if d in r.requests_off)}


def check(P: Problem, assignment, result):
    """Independent check of a backup result against the clinical schedule. Plain loops, nothing shared
    with the optimisation above except reading the configuration. Returns plain-English violations."""
    if not result:
        return []
    V = []
    L = {l.k: l for l in lines(P)}
    per = defaultdict(list)                     # resident -> [(day, start, end, line)]
    for e in result["days"]:
        l = L[e["line"]]
        if len(e["assigned"]) > l.need:
            V.append(f"{l.name} {P.label(e['day'])}: {len(e['assigned'])} people, only {l.need} needed")
        for rid in e["assigned"]:
            per[rid].append((e["day"], e["start"], e["end"], l))
    for rid, items in per.items():
        r = P.by_id.get(rid)
        if r is None:
            V.append(f"unknown resident {rid} on backup"); continue
        shifts = validator.worked(P, r, assignment)
        for d, a, b, l in items:
            tag = f"{r.name}: {l.name} {P.label(d)}"
            if l.eligible is not None and rid not in l.eligible:
                V.append(f"{tag}: not eligible")
            if d in r.vacation or d in r.mandatory_off:
                V.append(f"{tag}: on vacation or a mandatory day off")
            for u in r.unavailable:
                if u.get("categories") and l.cat not in u["categories"]:
                    continue
                if u.get("sites"):
                    continue
                lo_, hi_, wd = u.get("from_day"), u.get("to_day"), u.get("weekdays")
                for dd in range(a // DAY - 1, (b - 1) // DAY + 1):
                    if (lo_ is not None and dd < lo_) or (hi_ is not None and dd > hi_) or (wd is not None and P.weekday(dd) not in wd):
                        continue
                    w0 = dd * DAY + (u["start_min"] if u.get("start_min") is not None else 0)
                    w1 = w0 + (u["dur_min"] if u.get("start_min") is not None else DAY)
                    if a < w1 and w0 < b:
                        V.append(f"{tag}: {u.get('label') or 'unavailable (rule)'}"); break
            if r.chief_days and any(a < y and x < b for x, y in P.chief_windows):
                V.append(f"{tag}: chief time")
            for s in shifts:
                if s.start < b + l.rest_after and a - l.rest_before < s.end:
                    V.append(f"{tag}: overlaps or is too close to the {s.name} shift on {P.label(s.cal)}")
                if l.not_after_night and P.is_night(s) and s.day == d - 1:
                    V.append(f"{tag}: the day after the {s.name} night shift")
                if l.not_before_night and P.is_night(s) and s.day == d + 1:
                    V.append(f"{tag}: the day before the {s.name} night shift")
            if l.not_next_to_vacation and (d - 1 in r.vacation or d + 1 in r.vacation):
                V.append(f"{tag}: next to vacation")
        days = sorted(d for d, *_ in items)
        if len(days) != len(set(days)):
            V.append(f"{r.name}: two backups on one day")
        for l in L.values():
            k = sum(1 for _, _, _, ll in items if ll is l)
            if l.max_per_person is not None and k > l.max_per_person:
                V.append(f"{r.name}: {k} {l.name} days (maximum {l.max_per_person})")
        gap = max((l.min_between for l in L.values()), default=0)
        for x, y in zip(days, days[1:]):
            if y - x <= gap:
                V.append(f"{r.name}: backups on {P.label(x)} and {P.label(y)} are closer than {gap} days apart")
        # 24h free of shifts, attended academic time AND backup, in every 7 days where the clinical schedule alone has one
        duty = sorted([(s.start, s.end) for s in shifts] + _sessions(P, r, shifts))
        with_b = sorted(duty + [(a, b) for _, a, b, _ in items])
        for d in range(-(P.rules.history_days - 1), P.n_days - 6):
            lo, hi = d * DAY, d * DAY + WEEK

            def longest(iv):
                best, cur = 0, lo
                for a, b in iv:
                    if b <= lo or a >= hi:
                        continue
                    best = max(best, a - cur); cur = max(cur, b)
                return max(best, hi - cur)
            if longest(duty) >= DAY and longest(with_b) < DAY:
                V.append(f"{r.name}: backup takes away the 24h free of duty in the 7 days from {P.label(d)}")
    return V
