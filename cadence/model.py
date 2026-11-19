"""Exact model, built as one independent block per resident.

Every rule except coverage concerns a single resident, so the model is a set of
per-resident blocks tied together only by the coverage rows. That lets the
solver work on the whole program at once (small/medium programs, or CP-SAT) or
on any subset of residents and days (large programs), using the same code.

All constraints are linear over 0/1 decisions x[resident, day, shift type].
"""
from __future__ import annotations
from collections import defaultdict
from math import gcd
import numpy as np
from scipy import sparse
from .problem import Problem, Resident, DAY, STAGES, COVER_STAGES

WEEK = 7 * DAY
BLOCK_STAGES = [s for s in STAGES if s not in COVER_STAGES]     # the others live on the coverage rows


class Block:
    def __init__(self, P: Problem, r: Resident, share):
        self.r = r
        self.lb, self.ub, self.integ = [], [], []
        self.rows = []                      # (idx, coef, lo, hi)
        self.defs = []                      # helper variables: (var, kind, [(idx, coef, bound)])
        self.terms = {s: ([], [], []) for s in BLOCK_STAGES}   # stage -> (idx, coef, day)
        self.notes = []
        self._build(P, share)
        self._finalize()

    # ---- tiny modelling helpers ------------------------------------------------
    def _var(self, lb, ub, integer):
        self.lb.append(lb); self.ub.append(ub); self.integ.append(integer)
        return len(self.lb) - 1

    @staticmethod
    def _merge(terms):
        acc = {}
        for v, c in terms:
            acc[v] = acc.get(v, 0) + c
        return [(v, c) for v, c in acc.items() if c != 0]

    def _row(self, terms, lo=None, hi=None):
        terms = self._merge(terms)
        if not terms:
            if (lo is not None and lo > 0) or (hi is not None and hi < 0):
                self.notes.append("a rule cannot be met by this resident whatever the schedule")
            return
        self.rows.append(([v for v, _ in terms], [c for _, c in terms], lo, hi))

    def _aux(self, kind, lb, ub, rows, integer=False):
        """Helper variable fully determined by the schedule.
        kind 'min': var + terms >= bound for each row  (takes the smallest value allowed)
        kind 'max': var + terms <= bound for each row  (takes the largest value allowed)
        kind 'eq' : var + terms == bound"""
        v = self._var(lb, ub, integer)
        d = []
        for terms, bound in rows:
            terms = self._merge(terms)
            if kind == "min":
                self._row([(v, 1)] + terms, lo=bound)
            elif kind == "max":
                self._row([(v, 1)] + terms, hi=bound)
            else:
                self._row([(v, 1)] + terms, lo=bound, hi=bound)
            d.append(([i for i, _ in terms], [c for _, c in terms], bound))
        self.defs.append((v, kind, d))
        return v

    def _goal(self, stage, var, coef=1, day=-99):
        i, c, d = self.terms[stage]
        i.append(var); c.append(coef); d.append(day)

    # ---- the model -------------------------------------------------------------
    def _build(self, P, share):
        r, R, n, H = self.r, P.rules, P.n_days, P.rules.history_days
        slots = [s for s in P.slot_list if P.static_block_reason(r, s) is None]
        hist = P.hist[r.id]
        x = {s.key: self._var(0, 1, True) for s in slots}
        self.nx = len(slots)
        self.keys = [s.key for s in slots]
        self.xday = np.array([s.day for s in slots], dtype=np.int32)
        self.xnight = np.array([P.is_night(s) for s in slots], dtype=bool)
        for h in hist:
            x[h.key] = self._var(1, 1, True)          # previous block: already worked
        mine = slots + hist
        byday = defaultdict(list)
        for s in mine:
            byday[s.day].append(s)
        X = lambda s: x[s.key]                                                    # noqa: E731
        work = lambda d: [(X(s), 1) for s in byday.get(d, ())]                    # noqa: E731
        night = lambda d: [(X(s), 1) for s in byday.get(d, ()) if P.is_night(s)]  # noqa: E731
        neg = lambda t: [(v, -c) for v, c in t]                                   # noqa: E731
        days = range(-H, n)

        # one shift per calendar day
        for d in days:
            if len(byday.get(d, ())) > 1:
                self._row(work(d), hi=1)

        # at most L days worked in a row: every L+1 consecutive days hold at most L shifts (one per day, above).
        # Only windows where every day has a possible shift can break it; history days are fixed at what was worked.
        L = P.max_run(r)
        if L:
            for w in range(-H, n - L):
                window = range(w, w + L + 1)
                if w + L >= 0 and all(byday.get(e) for e in window):
                    self._row([t for e in window for t in work(e)], hi=L)

        # rest after a shift >= its own length (carries across the block boundary)
        for a in mine:
            need = P.rest_after(a)
            for d in (a.day + 1, a.day + 2, a.day + 3):
                clash = [b for b in byday.get(d, ()) if b.start - a.end < need and not b.hist]
                if clash:
                    self._row([(X(a), 1)] + [(X(b), 1) for b in clash], hi=1)

        # rolling 7-day clinical-time limit, on EVERY window that starts at a possible shift
        # start or ends at a possible shift end (the only places a maximum can occur).
        # C[d] = minutes worked up to and including day d keeps the rows short.
        C = {-H - 1: None}
        for d in days:
            prev = [(C[d - 1], -1)] if C[d - 1] is not None else []
            C[d] = self._aux("eq", 0, (H + n) * DAY, [(prev + [(X(s), -s.dur) for s in byday.get(d, ())], 0)])
        for t in sorted({s.start for s in mine} | {s.end - WEEK for s in mine}):
            if t + WEEK <= 0 or t < -H * DAY or t >= n * DAY:
                continue
            d0, d1 = t // DAY - 1, min((t + WEEK) // DAY, n - 1)
            full, part, worst = [], [], 0
            for e in range(max(d0, -H), d1 + 1):
                ov = [(s, max(0, min(s.end, t + WEEK) - max(s.start, t))) for s in byday.get(e, ())]
                worst += max((o for _, o in ov), default=0)
                if all(o == s.dur for s, o in ov):
                    full.append(e)
                else:
                    part += [(X(s), o) for s, o in ov if o]
            if worst <= R.max_week_minutes:
                continue
            terms = part
            if full:                         # longest contiguous run of fully-inside days -> C difference
                runs, cur = [], [full[0]]
                for e in full[1:]:
                    if e == cur[-1] + 1:
                        cur.append(e)
                    else:
                        runs.append(cur); cur = [e]
                runs.append(cur)
                best = max(runs, key=len)
                terms = terms + [(C[best[-1]], 1)] + ([(C[best[0] - 1], -1)] if C[best[0] - 1] is not None else [])
                for run in runs:
                    if run is not best:
                        terms += [(X(s), s.dur) for e in run for s in byday.get(e, ())]
            self._row(terms, hi=R.max_week_minutes)

        # one continuous 24h free of all duty (shifts + academic time) in every 7 days.
        # free[c] = 1 means [c, c+24h) is completely free. A free day can always be slid
        # back to the end of the previous duty or to midnight, so only those start times
        # need a variable.
        att = [a for a in P.academic if P.attends(r, a)]
        blocked = [(a.start, a.end) for a in att if a.policy == "blocked"]
        # "excused" sessions: attended (so not free) unless the resident works a shift across them
        excused = [(a, [(X(s), -1) for s in mine if s.start < a.block_to and a.block_from < s.end])
                   for a in att if a.policy != "blocked"]
        cands = sorted({s.end for s in mine} | {a.end for a in att} | {d * DAY for d in days})
        free = {}
        for c in cands:
            if c < -H * DAY or c + DAY > n * DAY:
                continue
            if any(c < b and a < c + DAY for a, b in blocked):
                continue
            rows = []
            for d in range(c // DAY - 2, c // DAY + 3):
                hit = [(X(s), 1) for s in byday.get(d, ()) if s.start < c + DAY and s.end > c]
                if hit:
                    rows.append((hit, 1))
            for a, working in excused:
                if c < a.end and a.start < c + DAY:
                    rows.append((working, 0))
            free[c] = self._aux("max", 0, 1, rows)
        for d in range(-(H - 1), n - 6):
            self._row([(f, 1) for c, f in free.items() if d * DAY <= c and c + DAY <= d * DAY + WEEK], lo=1)

        # contract: maximum is hard; shortfall below the minimum is a slack (stage 2)
        count = [(X(s), 1) for s in slots]
        self._row(count, hi=r.shifts_max)
        short = self._aux("min", 0, max(r.shifts_min, 0), [(count, r.shifts_min)])
        self._goal("contract shortfall", short)

        # nights: cap, and number of separate runs
        self._row([(X(s), 1) for s in slots if P.is_night(s)], hi=R.max_nights)
        start = {}
        for d in range(n):
            if night(d):
                start[d] = self._aux("min", 0, 1, [(neg(night(d)) + night(d - 1), 0)])
        self._row([(v, 1) for v in start.values()], hi=R.max_night_runs)

        # ---------------- soft goals ----------------
        ncat = len(P.cat_order)
        for d in range(-1, n - 1):                   # circadian: no backward rotation day to day
            rows = []                                # one count per backward step, however large
            for k in range(1, ncat):
                late = [(X(s), 1) for s in byday.get(d, ()) if P.cat_order[s.cat] >= k]
                early = [(X(s), 1) for s in byday.get(d + 1, ()) if P.cat_order[s.cat] < k]
                if late and early:
                    rows.append((neg(late) + neg(early), -1))
            if rows:
                self._goal("backward rotations", self._aux("min", 0, 1, rows), day=d)
        for g in sorted({P.balance_group[c] for c in P.cat_order}):
            if (r.id, g) not in share:
                continue
            cnt = [(X(s), 10) for s in slots if P.balance_group[s.cat] == g]
            tol = int(round(10 * R.balance_tolerance_shifts))
            dev = self._aux("min", 0, 10 * n + share[r.id, g],
                            [(neg(cnt), -share[r.id, g] - tol), (cnt, share[r.id, g] - tol)])
            self._goal("day/evening/night balance", dev)
        for d, st in start.items():                  # >= 7 days between runs of nights
            prior = [e for e in range(d - R.min_gap_between_night_runs, d - 1) if night(e)]
            if prior:
                v = self._aux("min", 0, 1, [([(st, -1)] + neg(night(e)), -1) for e in prior])
                self._goal("night runs too close", v, day=d)
        for s in slots:                              # no overnight shift running into vacation
            if s.end > (s.cal + 1) * DAY and s.cal + 1 in r.vacation:
                self._goal("nights into vacation", X(s), day=s.day)
        g = gcd(100, R.max_night_fraction_pct)       # nights <= 45% of scheduled time
        ex = self._aux("min", 0, 100 * n * DAY, [(
            [(X(s), -((100 * s.dur if P.is_night(s) else 0) - R.max_night_fraction_pct * s.dur) // g) for s in slots], 0)])
        self._goal("night share over limit", ex)
        for site, a, b in P.pod_pairs:               # pod balance (e.g. T/M, GP/CC)
            if all(any(s.site == site and s.pod == p and r.pgy >= s.min_pgy and (r.sites is None or site in r.sites)
                       and (r.only_refs is None or s.ref in r.only_refs)
                       for s in P.slot_list) for p in (a, b)):
                diff = [(X(s), 1 if s.pod == a else -1) for s in slots if s.site == site and s.pod in (a, b)]
                pt = R.pod_tolerance_shifts
                self._goal("pod balance", self._aux("min", 0, n, [(diff, -pt), (neg(diff), -pt)]))
        if r.site_share:                             # target split between sites, within the tolerance (x100: percent)
            tol = 100 * R.site_share_tolerance_shifts
            for site, pct in sorted(r.site_share.items()):
                diff = [(X(s), 100 * (s.site == site) - pct) for s in slots]       # 100 x at site - pct x all
                if any(c for _, c in diff):
                    self._goal("site split", self._aux("min", 0, 100 * n, [(diff, -tol), (neg(diff), -tol)]))
        for d in range(0, n - 1):                    # isolated single days off
            iso = self._aux("min", 0, 1, [(neg(work(d - 1)) + neg(work(d + 1)) + work(d), -1)])
            self._goal("isolated days off", iso, day=d)
        extra = self._aux("min", 0, max(R.max_night_runs, 1), [([(v, -1) for v in start.values()], -1)])
        self._goal("extra / over-long night runs", extra)
        k = R.soft_max_nights_in_run + 1
        for d in range(-(k - 1), n - k + 1):
            if all(night(e) for e in range(d, d + k)):
                lng = self._aux("min", 0, 1, [([t for e in range(d, d + k) for t in neg(night(e))], -(k - 1))])
                self._goal("extra / over-long night runs", lng, day=d + k // 2)
        for s in slots:                              # requests off are for calendar dates
            if s.cal in r.requests_off:
                self._goal("requests off missed", X(s), r.requests_off[s.cal], day=s.day)

    # ---- numeric form ------------------------------------------------------------
    def _finalize(self):
        self.nv = len(self.lb)
        self.lb = np.array(self.lb, dtype=float)
        self.ub = np.array(self.ub, dtype=float)
        self.integ = np.array(self.integ, dtype=bool)
        indptr, idx, val, lo, hi = [0], [], [], [], []
        for i, c, l, h in self.rows:
            idx += i; val += c; indptr.append(len(idx))
            lo.append(-np.inf if l is None else l); hi.append(np.inf if h is None else h)
        self.A = sparse.csr_matrix((np.array(val, dtype=float), np.array(idx, dtype=np.int32),
                                    np.array(indptr, dtype=np.int32)), shape=(len(self.rows), self.nv))
        self.rlo, self.rhi = np.array(lo, dtype=float), np.array(hi, dtype=float)
        self.rows = None
        self.goal = {s: (np.array(i, dtype=np.int32), np.array(c, dtype=float), np.array(d, dtype=np.int32))
                     for s, (i, c, d) in self.terms.items()}
        self.xpos = {k: j for j, k in enumerate(self.keys)}
        self.hist_vars = [j for j in range(self.nx, self.nv) if self.lb[j] == 1 and self.integ[j]]

    def complete(self, xvals):
        """Fill in every helper variable from a 0/1 schedule vector."""
        v = [0.0] * self.nv
        v[:self.nx] = [float(t) for t in xvals]
        for j in self.hist_vars:
            v[j] = 1.0
        lb, ub = self.lb, self.ub
        for var, kind, rows in self.defs:
            if kind == "min":
                val = lb[var]
                for idx, coef, bound in rows:
                    val = max(val, bound - sum(c * v[i] for i, c in zip(idx, coef)))
            elif kind == "max":
                val = ub[var]
                for idx, coef, bound in rows:
                    val = min(val, bound - sum(c * v[i] for i, c in zip(idx, coef)))
            else:
                idx, coef, bound = rows[0]
                val = bound - sum(c * v[i] for i, c in zip(idx, coef))
            v[var] = val
        return np.array(v)

    def broken_rows(self, v):
        a = self.A @ v
        return int(np.sum((a < self.rlo - 1e-6) | (a > self.rhi + 1e-6)) + np.sum((v < self.lb - 1e-6) | (v > self.ub + 1e-6)))

    def value(self, v, stage):
        i, c, _ = self.goal[stage]
        return float(v[i] @ c) if len(i) else 0.0
