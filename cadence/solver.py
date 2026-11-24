"""Pre-check -> greedy warm start -> staged exact optimisation with open-shift slack.

Two ways of running the staged optimisation, same model and same code path:

  full  - every resident and every day in one exact solve per goal. Gives proofs
          of optimality. Right for small/medium programs, and for CP-SAT.
  lns   - large programs: keep the whole schedule feasible at all times and
          repeatedly hand the exact solver a neighbourhood (some residents x some
          days), with everything else held fixed. Goals are still handled in strict
          priority order: a move may never make an earlier goal worse.
"""
from __future__ import annotations
import random
import time
from collections import defaultdict
from math import gcd
import numpy as np
from scipy import sparse
from .problem import Problem, DAY, STAGES, COVER_STAGES, clock
from .model import BLOCK_STAGES, Block
from . import mip, validator

WEEK = 7 * DAY


# ---------------------------------------------------------------------------
# 1. Capacity pre-check (plain arithmetic, milliseconds)
# ---------------------------------------------------------------------------
def precheck(P: Problem):
    errors, warnings = [], []
    R, S, rules = P.residents, P.slot_list, P.rules
    # days (the day a shift belongs to) on which each resident could work at least one shift
    can = {r.id: defaultdict(int) for r in R}
    for s in S:
        for r in R:
            if P.static_block_reason(r, s) is None:
                can[r.id][s.day] = max(can[r.id][s.day], s.min_pgy)
    avail = {r.id: sorted(can[r.id]) for r in R}
    cap = {r.id: min(r.shifts_max, len(avail[r.id])) for r in R}

    def gap(what, need, have, unit="shifts"):
        if need > have:
            errors.append(f"{what}: {need:g} {unit} needed but only {have:g} available.")
        elif need > 0.97 * have:
            warnings.append(f"{what}: tight - {need:g} {unit} needed, {have:g} available.")

    total = sum(s.need for s in S)
    gap("Total coverage", total, sum(cap.values()))
    if sum(r.shifts_min for r in R) > total:
        errors.append(f"Contract minimums add up to {sum(r.shifts_min for r in R)} shifts but the block only has "
                      f"{total}: someone cannot reach their minimum.")
    gap("Total clinical hours", sum(s.need * s.dur for s in S) / 60,
        sum(rules.max_week_minutes * len(avail[r.id]) / 7 for r in R) / 60, "hours")
    nights = [s for s in S if P.is_night(s)]
    gap("Night shifts", sum(s.need for s in nights), rules.max_nights * len(R))
    for lvl in sorted({s.min_pgy for s in S if s.min_pgy > 1}):
        tier = [r for r in R if r.pgy >= lvl]
        gap(f"Shifts restricted to PGY-{lvl}+", sum(s.need for s in S if s.min_pgy >= lvl), sum(cap[r.id] for r in tier))
        gap(f"Night shifts restricted to PGY-{lvl}+", sum(s.need for s in nights if s.min_pgy >= lvl),
            rules.max_nights * len(tier))
    for site in sorted({s.site for s in S}):
        pool = [r for r in R if r.sites is None or site in r.sites]
        if len(pool) < len(R):
            gap(f"Shifts at {site}", sum(s.need for s in S if s.site == site), sum(cap[r.id] for r in pool))

    # every shift needs enough people who could ever take it
    n_none = 0
    for s in S:
        why = defaultdict(int)
        for r in R:
            why[P.static_block_reason(r, s) or "ok"] += 1
        if why["ok"] < s.need:
            n_none += 1
            if n_none <= 8:
                detail = ", ".join(f"{v} {k}" for k, v in why.items() if k != "ok")
                errors.append(f"{s.name} on {P.label(s.cal)} {clock(s.start)}: needs {s.need} but only {why['ok']} "
                              f"residents could ever work it ({detail}).")
    if n_none > 8:
        errors.append(f"...and {n_none - 8} more shifts with too few eligible residents.")

    # per day and per week, overall and for each PGY-restricted tier
    shortest = min((s.dur for s in S), default=60)
    for lvl in sorted({s.min_pgy for s in S}):
        tier = [r for r in R if r.pgy >= lvl]
        tag = "" if lvl == 1 else f" needing PGY-{lvl}+"
        for d in range(P.n_days):
            need = sum(s.need for s in S if s.day == d and s.min_pgy >= lvl)
            have = sum(can[r.id].get(d, 0) >= lvl for r in tier)
            if need > have:
                errors.append(f"{P.label(d)}: {need} shifts{tag} but only {have} residents available that day.")
        for w in range(0, P.n_days, 7):
            days = range(w, min(w + 7, P.n_days))
            wk = [s for s in S if s.day in days and s.min_pgy >= lvl]
            need = sum(s.need for s in wk)
            # one 24h break a week => at most 6 working days; rolling-hours cap limits it further
            per = min(6, rules.max_week_minutes // shortest)
            have = sum(min(per, sum(can[r.id].get(d, 0) >= lvl for d in days)) for r in tier)
            if need > have:
                errors.append(f"Week of {P.label(w)}: {need} shifts{tag} but residents can work at most {have}.")
            hrs, cap_h = sum(s.need * s.dur for s in wk) / 60, len(tier) * rules.max_week_minutes / 60
            if hrs > cap_h:
                errors.append(f"Week of {P.label(w)}: {hrs:g} clinical hours{tag} but the weekly cap allows {cap_h:g}.")
    for r in R:
        most = (rules.max_week_minutes // shortest) * P.n_days / 7
        if r.shifts_min > min(most, len(avail[r.id])):
            warnings.append(f"{r.name}: contract minimum of {r.shifts_min} shifts may be unreachable "
                            f"({len(avail[r.id])} available days, weekly-hours cap).")
    from .report import past_notes
    warnings += past_notes(P)
    return errors, warnings


# ---------------------------------------------------------------------------
# 2. Greedy warm start: nights first, then day by day; least-loaded eligible resident
# ---------------------------------------------------------------------------
def greedy(P: Problem):
    R = P.residents
    load = {r.id: list(P.hist[r.id]) for r in R}
    byday = {r.id: {s.day: s for s in P.hist[r.id]} for r in R}
    count = defaultdict(int); nights = defaultdict(int)
    ok_static = {r.id: {s.key for s in P.slot_list if P.static_block_reason(r, s) is None} for r in R}
    assignment = {r.id: [] for r in R}
    rng = random.Random(1)
    units = [s for s in P.slot_list for _ in range(s.need)]
    units.sort(key=lambda s: (0 if P.is_night(s) else 1, s.day, -s.min_pgy, s.start))
    # each resident's fair number of nights: aim to work them as ONE run
    tot_cap = sum(r.shifts_max for r in R) or 1
    n_nights = sum(1 for s in units if P.is_night(s))
    target = {r.id: -(-n_nights * r.shifts_max // tot_cap) for r in R}
    for s in units:
        is_n = P.is_night(s)
        cands = []
        for r in R:
            bd = byday[r.id]
            if s.key not in ok_static[r.id] or s.day in bd or count[r.id] >= r.shifts_max:
                continue
            if is_n and nights[r.id] >= P.rules.max_nights:
                continue
            prev, nxt = bd.get(s.day - 1), bd.get(s.day + 1)
            if prev and s.start - prev.end < P.rest_after(prev):
                continue
            if nxt and nxt.start - s.end < P.rest_after(s):
                continue
            back = int(bool(prev and P.cat_order[s.cat] < P.cat_order[prev.cat])
                       or bool(nxt and P.cat_order[nxt.cat] < P.cat_order[s.cat]))
            extends = is_n and bool((prev and P.is_night(prev)) or (nxt and P.is_night(nxt)))
            if is_n:        # continue a run up to the target, else start someone's first run
                tier = (0 if nights[r.id] < target[r.id] else 2) if extends else (1 if nights[r.id] == 0 else 3)
            else:
                tier = back
            cands.append(((tier, (count[r.id] + 1) / max(r.shifts_max, 1), nights[r.id], rng.random()), r))
        for _, r in sorted(cands, key=lambda c: c[0]):
            if not validator.check_resident(P, r, load[r.id] + [s], check_min=False):
                assignment[r.id].append(s.key)
                load[r.id].append(s); byday[r.id][s.day] = s
                count[r.id] += 1; nights[r.id] += is_n
                break
    # anyone still under their contract minimum may take an optional place (a shift with room above its minimum)
    filled = defaultdict(int)
    for keys in assignment.values():
        for k in keys:
            filled[k] += 1
    spare = [s for s in P.slot_list if s.cap > s.need]
    for r in sorted(R, key=lambda r: count[r.id] - r.shifts_min):
        for s in rng.sample(spare, len(spare)):
            if count[r.id] >= r.shifts_min:
                break
            if filled[s.key] >= s.cap or s.key not in ok_static[r.id] or s.day in byday[r.id]:
                continue
            if P.is_night(s) and nights[r.id] >= P.rules.max_nights:
                continue
            if not validator.check_resident(P, r, load[r.id] + [s], check_min=False):
                assignment[r.id].append(s.key)
                load[r.id].append(s); byday[r.id][s.day] = s
                count[r.id] += 1; nights[r.id] += P.is_night(s); filled[s.key] += 1
    return assignment


# ---------------------------------------------------------------------------
# 2b. Plain-code polish: single swaps and hand-offs, accepted only if the goals
#     improve in strict priority order and every hard rule still holds.
# ---------------------------------------------------------------------------
def polish(P: Problem, assignment, seconds=60.0, seed=0):
    t0, rng = time.time(), random.Random(seed)
    share = P.balance_share()
    ids = [r.id for r in P.residents]
    ok = {r.id: {s.key for s in P.slot_list if P.static_block_reason(r, s) is None} for r in P.residents}
    cur = {rid: {P.slots[k].day: P.slots[k] for k in assignment[rid]} for rid in ids}
    filled = defaultdict(int)
    for rid in ids:
        for s in cur[rid].values():
            filled[s.key] += 1

    def vec(rid, bd):
        m = validator.soft_resident(P, P.by_id[rid], P.hist[rid] + list(bd.values()), share)
        return tuple(m[s] for s in BLOCK_STAGES)

    def feas(rid, bd):
        return not validator.check_resident(P, P.by_id[rid], P.hist[rid] + list(bd.values()), check_min=False)

    def with_(bd, d, s):
        nb = dict(bd)
        if s is None:
            nb.pop(d, None)
        else:
            nb[d] = s
        return nb

    def better(a, na, b, nb):
        va, vb = vec(a, na), vec(b, nb)
        if tuple(map(sum, zip(va, vb))) < tuple(map(sum, zip(V[a], V[b]))) and feas(a, na) and feas(b, nb):
            cur[a], cur[b], V[a], V[b] = na, nb, va, vb
            return True
        return False

    def compound(limit):
        """Random multi-day moves: swap two residents' whole schedules over a few days,
        or trade one shift for another on a different day."""
        found = stale = 0
        n = P.n_days
        while stale < limit and time.time() - t0 < seconds:
            stale += 1
            a, b = rng.sample(ids, 2)
            if rng.random() < 0.5:
                L = rng.randint(2, 8); d1 = rng.randrange(0, n - L + 1)
                sa = {d: cur[a][d] for d in range(d1, d1 + L) if d in cur[a]}
                sb = {d: cur[b][d] for d in range(d1, d1 + L) if d in cur[b]}
                if {d: s.key for d, s in sa.items()} == {d: s.key for d, s in sb.items()}:
                    continue
                if any(s.key not in ok[b] for s in sa.values()) or any(s.key not in ok[a] for s in sb.values()):
                    continue
                na = {d: s for d, s in cur[a].items() if d not in sa}; na.update(sb)
                nb = {d: s for d, s in cur[b].items() if d not in sb}; nb.update(sa)
            else:
                if not cur[a] or not cur[b]:
                    continue
                d = rng.choice(list(cur[a])); s = cur[a][d]
                d2 = rng.choice(list(cur[b])); s2 = cur[b][d2]
                if d2 == d or d in cur[b] or d2 in cur[a] or s.key not in ok[b] or s2.key not in ok[a]:
                    continue
                na = with_(with_(cur[a], d, None), d2, s2); nb = with_(with_(cur[b], d2, None), d, s)
            if len(na) > P.by_id[a].shifts_max or len(nb) > P.by_id[b].shifts_max:
                continue
            if better(a, na, b, nb):
                found += 1; stale = 0
        return found

    def chain_fill(s):
        """Fill open shift s with a two-step chain: B takes s after handing one of
        their shifts t to C."""
        cand = [rid for rid in ids if s.key in ok[rid]]
        rng.shuffle(cand)
        for b in cand:
            if time.time() - t0 > seconds:
                return False
            for t in list(cur[b].values()):
                if s.day in cur[b] and t.day != s.day:
                    continue
                nb = with_(with_(cur[b], t.day, None), s.day, s)
                if not feas(b, nb):
                    continue
                for c in rng.sample(ids, len(ids)):
                    if c == b or t.key not in ok[c] or t.day in cur[c] or len(cur[c]) >= P.by_id[c].shifts_max:
                        continue
                    nc = with_(cur[c], t.day, t)
                    if feas(c, nc):
                        cur[b], cur[c], V[b], V[c] = nb, nc, vec(b, nb), vec(c, nc)
                        return True
        return False

    V = {rid: vec(rid, cur[rid]) for rid in ids}
    spare = [s for s in P.slot_list if s.cap > s.need]
    moves, improved = 0, True
    while improved and time.time() - t0 < seconds:
        improved = False
        got = compound(1500 * len(ids)) if moves else 0
        moves += got
        for s in P.slot_list:                                # fill anything still open
            while filled[s.key] < s.need:
                for rid in rng.sample(ids, len(ids)):
                    if s.key in ok[rid] and s.day not in cur[rid] and len(cur[rid]) < P.by_id[rid].shifts_max:
                        nb = with_(cur[rid], s.day, s)
                        if feas(rid, nb):
                            cur[rid], V[rid] = nb, vec(rid, nb)
                            filled[s.key] += 1; moves += 1; improved = True
                            break
                else:
                    if chain_fill(s):
                        filled[s.key] += 1; moves += 1; improved = True
                    else:
                        break
        for rid in rng.sample(ids, len(ids)):                # under contract minimum: take an optional place
            r = P.by_id[rid]
            for s in rng.sample(spare, len(spare)):
                if len(cur[rid]) >= r.shifts_min or time.time() - t0 > seconds:
                    break
                if filled[s.key] >= s.cap or s.key not in ok[rid] or s.day in cur[rid]:
                    continue
                nb = with_(cur[rid], s.day, s)
                if feas(rid, nb):
                    cur[rid], V[rid] = nb, vec(rid, nb)
                    filled[s.key] += 1; moves += 1; improved = True
        for d in rng.sample(range(P.n_days), P.n_days):
            if time.time() - t0 > seconds:
                break
            on = [rid for rid in ids if d in cur[rid]]
            off = [rid for rid in ids if d not in cur[rid]]
            for i, a in enumerate(on):                       # two residents trade shifts on the same day
                for b in on[i + 1:]:
                    sa, sb = cur[a].get(d), cur[b].get(d)
                    if sa is None or sb is None or sa.key == sb.key or sb.key not in ok[a] or sa.key not in ok[b]:
                        continue
                    na, nb = with_(cur[a], d, sb), with_(cur[b], d, sa)
                    va, vb = vec(a, na), vec(b, nb)
                    if tuple(map(sum, zip(va, vb))) < tuple(map(sum, zip(V[a], V[b]))) and feas(a, na) and feas(b, nb):
                        cur[a], cur[b], V[a], V[b] = na, nb, va, vb
                        moves += 1; improved = True
            for a in on:                                     # one resident hands a shift to another
                for b in off:
                    sa = cur[a].get(d)
                    if sa is None:
                        break
                    if d in cur[b] or sa.key not in ok[b] or len(cur[b]) >= P.by_id[b].shifts_max:
                        continue
                    na, nb = with_(cur[a], d, None), with_(cur[b], d, sa)
                    va, vb = vec(a, na), vec(b, nb)
                    if tuple(map(sum, zip(va, vb))) < tuple(map(sum, zip(V[a], V[b]))) and feas(a, na) and feas(b, nb):
                        cur[a], cur[b], V[a], V[b] = na, nb, va, vb
                        moves += 1; improved = True
        if got:
            improved = True
    moves += compound(1500 * len(ids))
    return {rid: [s.key for s in cur[rid].values()] for rid in ids}, moves


def trim_extras(P: Problem, assignment):
    """Give back optional places (people beyond a shift's minimum headcount) held by someone who is above their
    contract minimum. Taking a shift away never breaks a hard rule and cannot add an open shift or a shortfall,
    so this only ever improves the goals in priority order. Returns (assignment, places given back)."""
    A = {rid: list(keys) for rid, keys in assignment.items()}
    filled = defaultdict(int)
    for keys in A.values():
        for k in keys:
            filled[k] += 1
    dropped = 0
    for s in P.slot_list:
        if filled[s.key] <= s.need:
            continue
        holders = sorted((rid for rid, keys in A.items() if s.key in keys), key=lambda rid: P.by_id[rid].shifts_min - len(A[rid]))
        for rid in holders:
            if filled[s.key] <= s.need:
                break
            if len(A[rid]) > P.by_id[rid].shifts_min:
                A[rid].remove(s.key); filled[s.key] -= 1; dropped += 1
    return A, dropped


# ---------------------------------------------------------------------------
# 3. Staged optimisation
# ---------------------------------------------------------------------------
class Scheduler:
    def __init__(self, P: Problem, backend="auto", log=print, seed=0, progress=None):
        self.P, self.log, self.rng = P, log, random.Random(seed)
        self.progress = progress or (lambda phase, **info: None)     # called at the START of each phase
        self.backend = ("cpsat" if mip.have_cpsat() else "highs") if backend == "auto" else backend
        share = P.balance_share()
        self.blocks = {r.id: Block(P, r, share) for r in P.residents}
        self.x, self.v = {}, {}
        self.filled = defaultdict(int)
        g = gcd(100, P.rules.max_night_fraction_pct)
        self.scale = {s: 1.0 for s in STAGES}
        self.scale["day/evening/night balance"] = 10.0
        self.scale["site split"] = 100.0
        self.scale["night share over limit"] = 6000.0 / g           # -> hours
        self.stats = defaultdict(int)

    # ---- state ---------------------------------------------------------------
    def load(self, assignment):
        self.filled = defaultdict(int)
        for r in self.P.residents:
            b = self.blocks[r.id]
            x = np.zeros(b.nx)
            for k in assignment.get(r.id, ()):
                x[b.xpos[k]] = 1
                self.filled[k] += 1
            self.x[r.id], self.v[r.id] = x, b.complete(x)

    def assignment(self):
        return {rid: [b.keys[j] for j in np.nonzero(self.x[rid] > 0.5)[0]] for rid, b in self.blocks.items()}

    def total(self, stage, K=None):
        if stage == "open shifts":
            return float(sum(max(0, s.need - self.filled[s.key]) for s in self.P.slot_list))
        if stage == "extra places used":
            return float(sum(max(0, self.filled[s.key] - s.need) for s in self.P.slot_list))
        return sum(self.blocks[rid].value(self.v[rid], stage) for rid in (K or self.blocks))

    def model_check(self):
        """Does the current schedule satisfy every row of the exact model?"""
        return sum(self.blocks[rid].broken_rows(self.v[rid]) for rid in self.blocks)

    # ---- one exact solve over a region ----------------------------------------
    def region(self, K, days, j, seconds, blend=True):
        """Optimise goal j over residents K and the given days (None = all days);
        everything else stays exactly as it is. Returns (improved, solver status)."""
        P, B = self.P, self.blocks
        dayset = None if days is None else np.array(sorted(days))
        off, offs = 0, {}
        lbs, ubs, ints, warm = [], [], [], []
        dat, ind, ptr, rlo, rhi = [], [], [np.zeros(1, dtype=np.int64)], [], []
        nnz = 0
        cover, mine = defaultdict(list), defaultdict(float)
        for rid in K:
            b = B[rid]; offs[rid] = off
            lb, ub = b.lb.copy(), b.ub.copy()
            if dayset is None:
                free = np.arange(b.nx)
            else:
                fixed = ~np.isin(b.xday, dayset)
                lb[:b.nx][fixed] = self.x[rid][fixed]; ub[:b.nx][fixed] = self.x[rid][fixed]
                free = np.nonzero(~fixed)[0]
            xr = self.x[rid]
            for jx in free:
                key = b.keys[jx]
                cover[key].append(off + jx); mine[key] += xr[jx]
            lbs.append(lb); ubs.append(ub); ints.append(b.integ); warm.append(self.v[rid])
            dat.append(b.A.data); ind.append(b.A.indices + off); ptr.append(b.A.indptr[1:] + nnz)
            rlo.append(b.rlo); rhi.append(b.rhi)
            nnz += b.A.nnz; off += b.nv
        nblock = off
        # coverage rows: residents in K + open - extra == the minimum headcount less what the rest of the program
        # covers. open = places still missing below the minimum; extra = optional places used above it, at most
        # (maximum - minimum)
        ei, ec, ep, elo, ehi = [], [], [0], [], []
        open_cols, extra_cols, open_now, extra_now = [], [], [], []
        for key, cols in cover.items():
            s = P.slots[key]
            need = s.need - (self.filled[key] - mine[key])
            total_now = self.filled[key]
            ei += cols + [off, off + 1]; ec += [1.0] * len(cols) + [1.0, -1.0]; ep.append(len(ei))
            elo.append(need); ehi.append(need)
            open_cols.append(off); extra_cols.append(off + 1)
            open_now.append(max(0.0, s.need - total_now)); extra_now.append(max(0.0, total_now - s.need))
            lbs.append(np.zeros(2)); ubs.append(np.array([max(need, 0.0), float(s.cap - s.need)])); ints.append(np.array([True, True]))
            warm.append(np.array([open_now[-1], extra_now[-1]]))
            off += 2
        nv = off
        cost = np.zeros(nv)

        def terms(stage):
            if stage == "open shifts":
                return np.array(open_cols, dtype=np.int64), np.ones(len(open_cols))
            if stage == "extra places used":
                return np.array(extra_cols, dtype=np.int64), np.ones(len(extra_cols))
            ii, cc = [], []
            for rid in K:
                i, c, _ = B[rid].goal[stage]
                ii.append(i + offs[rid]); cc.append(c)
            return np.concatenate(ii), np.concatenate(cc)

        before = [self._region_value(s, K, (open_now, extra_now)) for s in STAGES]
        for i in range(j):                                   # earlier goals may not get worse
            ti, tc = terms(STAGES[i])
            if len(ti):
                ei += list(ti); ec += list(tc); ep.append(len(ei))
                elo.append(-np.inf); ehi.append(before[i] + 1e-6)
        ti, tc = terms(STAGES[j])
        big = 1000.0 if blend else 1.0
        np.add.at(cost, ti, tc * big / (self.scale[STAGES[j]] if blend else 1.0))
        if blend:                                            # later goals as a tie-break only
            for l in range(j + 1, len(STAGES)):
                ti, tc = terms(STAGES[l])
                np.add.at(cost, ti, tc / self.scale[STAGES[l]])
        if not np.any(cost):
            return False, "nothing to do"
        A = sparse.csr_matrix((np.concatenate(dat + [np.array(ec, dtype=float)]),
                               np.concatenate(ind + [np.array(ei, dtype=np.int64)]),
                               np.concatenate(ptr + [np.array(ep[1:], dtype=np.int64) + nnz])),
                              shape=(sum(len(a) for a in rlo) + len(elo), nv))
        m = mip.Model(np.concatenate(lbs), np.concatenate(ubs), np.concatenate(ints), A,
                      np.concatenate(rlo + [np.array(elo, dtype=float)]),
                      np.concatenate(rhi + [np.array(ehi, dtype=float)]), cost)
        w = np.concatenate(warm)
        status, vals, _ = mip.solve(m, seconds, warm=w, backend=self.backend)
        self.stats["solves"] += 1
        if vals is None:
            self.stats["no solution: " + status] += 1
            return False, status

        # ---- accept only what the independent checker also accepts -------------
        newx, newv = {}, {}
        for rid in K:
            b = B[rid]
            xn = np.round(vals[offs[rid]:offs[rid] + b.nx])
            if not np.array_equal(xn, self.x[rid]):
                vn = b.complete(xn)
                r = P.by_id[rid]
                shifts = P.hist[rid] + [P.slots[b.keys[q]] for q in np.nonzero(xn > 0.5)[0]]
                if b.broken_rows(vn) or validator.check_resident(P, r, shifts, check_min=False):
                    self.stats["rejected by validator"] += 1
                    return False, status
                newx[rid], newv[rid] = xn, vn
        if not newx:
            return False, status
        delta = defaultdict(float)
        for rid, xn in newx.items():
            for q in np.nonzero(xn != self.x[rid])[0]:
                delta[B[rid].keys[q]] += xn[q] - self.x[rid][q]
        if any(self.filled[k] + dv > P.slots[k].cap + 1e-9 for k, dv in delta.items()):
            self.stats["rejected: overfill"] += 1
            return False, status
        oldx = {rid: self.x[rid] for rid in newx}; oldv = {rid: self.v[rid] for rid in newx}
        for rid in newx:
            self.x[rid], self.v[rid] = newx[rid], newv[rid]
        tot_after = {key: self.filled[key] + delta.get(key, 0.0) for key in cover}
        open_after = [max(0.0, P.slots[key].need - tot_after[key]) for key in cover]
        extra_after = [max(0.0, tot_after[key] - P.slots[key].need) for key in cover]
        after = [self._region_value(s, K, (open_after, extra_after)) for s in STAGES]
        lead_b = [round(before[i] / self.scale[STAGES[i]], 6) for i in range(j + 1)]
        lead_a = [round(after[i] / self.scale[STAGES[i]], 6) for i in range(j + 1)]
        tail_b = sum(before[i] / self.scale[STAGES[i]] for i in range(j + 1, len(STAGES)))
        tail_a = sum(after[i] / self.scale[STAGES[i]] for i in range(j + 1, len(STAGES)))
        if lead_a > lead_b or (lead_a == lead_b and tail_a >= tail_b - 1e-9):
            for rid in newx:                                 # no gain: undo
                self.x[rid], self.v[rid] = oldx[rid], oldv[rid]
            return False, status
        for k, dv in delta.items():
            self.filled[k] += int(round(dv))
        return lead_a < lead_b, status

    def _region_value(self, stage, K, cover_now):
        if stage == "open shifts":
            return float(sum(cover_now[0]))
        if stage == "extra places used":
            return float(sum(cover_now[1]))
        return sum(self.blocks[rid].value(self.v[rid], stage) for rid in K)

    def _night_days(self, rid):
        b = self.blocks[rid]
        return sorted(int(d) for d in b.xday[(self.x[rid] > 0.5) & b.xnight])

    # ---- neighbourhood choice --------------------------------------------------
    def pick(self, j, it):
        P, rng, n = self.P, self.rng, self.P.n_days
        ids = [r.id for r in P.residents]
        stage = STAGES[j]
        if stage == STAGES[0]:
            opens = [s for s in P.slot_list if self.filled[s.key] < s.need]
            s = rng.choice(opens)
            m, w = [(16, 2), (10, 4), (22, 1), (6, 10), (12, 3)][it % 5]
            cnt = {rid: float(self.x[rid].sum()) for rid in ids}
            elig = [rid for rid in ids if s.key in self.blocks[rid].xpos]
            spare = [rid for rid in elig if cnt[rid] < P.by_id[rid].shifts_max]
            K = set(rng.sample(spare, min(len(spare), m // 2)))
            K |= set(rng.sample(elig, min(len(elig), m // 4)))
            rest = [rid for rid in ids if rid not in K]
            K |= set(rng.sample(rest, min(len(rest), max(0, m - len(K)))))
            return sorted(K), range(max(0, s.day - w), min(n, s.day + w + 1))
        if stage == "extra places used":                  # a shift above its minimum: its people, and others nearby
            over = [s for s in P.slot_list if self.filled[s.key] > s.need]
            if not over:
                return None, None
            s = rng.choice(over)
            on = [rid for rid in ids if s.key in self.blocks[rid].xpos and self.x[rid][self.blocks[rid].xpos[s.key]] > 0.5]
            m, w = [(10, 3), (16, 2), (6, 6), (24, None)][it % 4]
            cnt = {q: float(self.x[q].sum()) for q in ids}
            rest = [rid for rid in ids if rid not in on and cnt[rid] > P.by_id[rid].shifts_min] or [rid for rid in ids if rid not in on]
            K = set(on) | set(rng.sample(rest, min(len(rest), max(0, m - len(on)))))
            return sorted(K), (None if w is None else range(max(0, s.day - w), min(n, s.day + w + 1)))
        hot = []
        for rid in ids:
            i, c, d = self.blocks[rid].goal[stage]
            if len(i):
                for q in np.nonzero(self.v[rid][i] * c > 1e-9)[0]:
                    hot.append((rid, int(d[q])))
        if not hot:
            return None, None
        rid, d = rng.choice(hot)
        if stage in ("night runs too close", "extra / over-long night runs") and it % 2 == 0:
            # reshaping runs of nights: this resident's whole night span, plus colleagues
            # who work nights right next to those runs
            nd = self._night_days(rid)
            if len(nd):
                near = {e for q in nd for e in (q - 2, q - 1, q + 1, q + 2)} - set(nd)
                cand = [q for q in ids if q != rid and near & set(self._night_days(q))]
                others = rng.sample(cand, min(len(cand), 5))
                return sorted({rid, *others}), range(max(0, int(nd[0]) - 3), min(n, int(nd[-1]) + 4))
        m, w = [(3, None), (14, 2), (6, 5), (20, 1), (8, 3)][it % 5]
        pool = [q for q in ids if q != rid]
        if stage == "contract shortfall":            # partners who can give a shift away
            cnt = {q: float(self.x[q].sum()) for q in ids}
            pool = [q for q in pool if cnt[q] > P.by_id[q].shifts_min] or pool
        others = rng.sample(pool, min(len(pool), m - 1))
        if w is None:
            return sorted({rid, *others}), None
        c = d if d >= 0 else rng.randrange(n)
        return sorted({rid, *others}), range(max(0, c - w), min(n, c + w + 1))

    # ---- the staged run -----------------------------------------------------------
    def run(self, strategy="auto", seconds=420.0, polish_seconds=60.0, sub_seconds=4.0, initial=None):
        """seconds = time allowed for the exact stage-by-stage optimisation.
        initial = a schedule to start from instead of building a new one ("optimize"); it must break no
        hard rule. Every later step only accepts changes that leave earlier goals no worse, so the result
        is never worse than the starting schedule on any goal, taken in priority order."""
        P, t0 = self.P, time.time()
        nx = sum(b.nx for b in self.blocks.values())
        if strategy == "auto":
            strategy = "full" if nx <= 1500 else "lns"
        self.log(f"Model: {len(self.blocks)} residents, {nx:,} assignment decisions, "
                 f"{sum(b.A.nnz for b in self.blocks.values()):,} non-zeros. "
                 f"Engine: {'OR-Tools CP-SAT' if self.backend == 'cpsat' else 'HiGHS'}, strategy: {strategy}")
        total_need = sum(s.need for s in P.slot_list)
        if initial is not None:
            self.progress("first schedule")
            V, _, _ = validator.validate(P, initial)
            if V:
                raise ValueError(f"the schedule to start from breaks {len(V)} hard rule(s), e.g. {V[0]}")
            g = {r.id: list(initial.get(r.id, [])) for r in P.residents}
            self.load(g)
            self.log(f"Starting from the given schedule: {int(self.total(STAGES[0]))} of {total_need} shifts open")
        else:
            self.progress("first schedule")
            g = greedy(P)
            self.load(g)
            self.log(f"Greedy warm start: {int(self.total(STAGES[0]))} of {total_need} shifts open ({time.time() - t0:.0f}s)")
        if polish_seconds:
            tp = time.time()
            self.progress("swaps", open=int(self.total(STAGES[0])))
            g, moves = polish(P, g, polish_seconds, seed=self.rng.randrange(10 ** 6))
            self.load(g)
            self.log(f"Swap polish: {moves} improving moves, {int(self.total(STAGES[0]))} shifts open ({time.time() - tp:.0f}s)")
        g, dropped = trim_extras(P, self.assignment())
        if dropped:
            self.load(g)
            self.log(f"Optional places not needed for anyone's contract minimum: {dropped} given back")
        bad = self.model_check()
        if bad:
            self.log(f"WARNING: warm-start schedule breaks {bad} model rows - model and validator disagree")
        weight = {STAGES.index(k): w for k, w in (("open shifts", 4.0), ("contract shortfall", 2.0), ("backward rotations", 3.0))}
        ids, deadline = [r.id for r in P.residents], time.time() + seconds
        first, status = {}, {}
        for sweep in range(1, 9):
            progressed = False
            for j, stage in enumerate(STAGES):
                ts, v0 = time.time(), self.total(stage)
                first.setdefault(stage, v0)
                if v0 <= 1e-9:
                    status[stage] = "optimal"
                    continue
                status.setdefault(stage, "best found")
                left = deadline - time.time()
                if left < 1.0 or status[stage] == "optimal":
                    continue
                self.progress("goal", goal=stage, value=v0 / self.scale[stage], open=int(self.total(STAGES[0])))
                todo = [l for l in range(j, len(STAGES)) if self.total(STAGES[l]) > 1e-9]
                budget = left * weight.get(j, 1.0) / sum(weight.get(l, 1.0) for l in todo)
                if strategy == "full":
                    _, st = self.region(ids, None, j, max(budget, 1.0), blend=False)
                    if st == "optimal":
                        status[stage] = "optimal"
                else:
                    it = fails = 0
                    slow = stage in ("open shifts", "night runs too close", "extra / over-long night runs")
                    while time.time() - ts < budget and self.total(stage) > 1e-9:
                        K, days = self.pick(j, it)
                        if K is None:
                            break
                        improved, _ = self.region(K, days, j, sub_seconds * (2 if slow else 1), blend=(j > 0))
                        it += 1
                        fails = 0 if improved else fails + 1
                        if fails >= 25:
                            break
                    self.stats["iterations"] += it
                v1 = self.total(stage)
                if v1 <= 1e-9:
                    status[stage] = "optimal"
                progressed |= v1 < v0 - 1e-9
                self.log(f"  pass {sweep}  {stage:<30} {v0 / self.scale[stage]:>7.1f} -> {v1 / self.scale[stage]:>7.1f}"
                         f"  {time.time() - ts:4.0f}s")
            if strategy == "full" or not progressed or deadline - time.time() < 1.0:
                break
        report = [(st, first.get(st, 0.0) / self.scale[st], self.total(st) / self.scale[st], status.get(st, "optimal"))
                  for st in STAGES]
        return {"assignment": self.assignment(), "stages": report, "seconds": time.time() - t0,
                "strategy": strategy, "backend": self.backend, "stats": dict(self.stats), "decisions": nx}


# ---------------------------------------------------------------------------
# 4. Plain-English explanation of open shifts
# ---------------------------------------------------------------------------
def _plain(v):
    for needle, label in (("two shifts on", "already working that day"), ("rest after", "not enough rest before/after"),
                          ("h in the 7 days", "would exceed the weekly hours cap"), ("contract maximum", "at contract maximum"),
                          ("no 24h free", "would lose their 24h break that week"), ("night shifts (limit", "at the night-shift limit"),
                          ("separate runs of nights", "would create too many runs of nights")):
        if needle in v:
            return label
    return v


def open_details(P: Problem, assignment):
    """Every shift still short of people, and for each one why nobody else can take it."""
    out = []
    filled = defaultdict(int)
    for keys in assignment.values():
        for k in keys:
            filled[k] += 1
    for s in P.slot_list:
        miss = s.need - filled[s.key]
        if miss <= 0:
            continue
        why = defaultdict(list)
        for r in P.residents:
            if s.key in assignment.get(r.id, ()):
                continue
            reason = P.static_block_reason(r, s)
            if reason is None:
                v = validator.check_resident(P, r, validator.worked(P, r, assignment) + [s], check_min=False)
                reason = _plain(v[0]) if v else "could take it (solver ran out of time)"
            why[reason].append(r.name)
        out.append({"shift": s, "missing": miss,
                    "reasons": [{"reason": k, "count": len(v), "names": v}
                                for k, v in sorted(why.items(), key=lambda kv: -len(kv[1]))]})
    return out


def explain_open(P: Problem, assignment, limit=12):
    out = []
    for o in open_details(P, assignment):
        s = o["shift"]
        parts = [f"{q['count']} {q['reason']}" + (f" ({', '.join(q['names'])})" if q["count"] <= 3 else "") for q in o["reasons"]]
        out.append(f"{s.name} {P.label(s.cal)} {clock(s.start)} ({s.dur / 60:g}h): {o['missing']} of {s.need} open. " + "; ".join(parts))
        if len(out) >= limit:
            out.append("...")
            break
    return out
