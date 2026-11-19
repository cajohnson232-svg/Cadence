"""Mutation test for the independent validator: break a valid schedule in known
ways and confirm each break is reported.

    python -m tests.test_validator
"""
import copy
from cadence.problem import Problem, DAY
from cadence.generate import make_config
from cadence import solver, validator

P = Problem(make_config((8, 12), 12, seed=11))
A, _ = solver.polish(P, solver.greedy(P), 10)
V, opens, short = validator.validate(P, A)
assert not V, V
print(f"baseline schedule: 0 violations, {sum(n for _, n in opens)} open")


def expect(name, B, needle):
    V = validator.validate(P, B)[0]
    hit = [v for v in V if needle in v]
    assert hit, f"{name}: validator missed it. Got {V[:3]}"
    print(f"caught: {name:<42} -> {hit[0]}")


def give(B, rid, s):
    B[rid] = [k for k in B[rid] if P.slots[k].day != s.day] + [s.key]


by_day = lambda rid, B: {P.slots[k].day: P.slots[k] for k in B[rid]}   # noqa: E731

# 1. shift on a vacation day
r = next(r for r in P.residents if r.vacation)
d = min(r.vacation); s = next(s for s in P.slot_list if s.day == d and s.min_pgy <= r.pgy)
B = copy.deepcopy(A); give(B, r.id, s); expect("shift on vacation", B, "vacation")
# 2. PGY-1 on a PGY-2+ shift
r = next(r for r in P.residents if r.pgy == 1); s = next(s for s in P.slot_list if s.min_pgy == 2)
B = copy.deepcopy(A); give(B, r.id, s); expect("PGY-1 on a PGY-2+ shift", B, "requires PGY-2+")
# 3. chief scheduled into chief time
r = next(r for r in P.residents if r.chief_days)
s = next(s for s in P.slot_list if any(s.start < b and a < s.end for a, b in P.chief_windows) and s.min_pgy <= r.pgy)
B = copy.deepcopy(A); give(B, r.id, s); expect("chief scheduled in chief time", B, "chief time")
# 4. too little rest: a morning shift straight after a night
done = False
for r in P.residents:
    bd = by_day(r.id, A)
    for d, n in bd.items():
        if P.is_night(n):
            s = next((s for s in P.slot_list if s.day == d + 1 and s.min_pgy <= r.pgy and 0 <= s.start - n.end < n.dur
                      and P.static_block_reason(r, s) is None), None)
            if s:
                B = copy.deepcopy(A); give(B, r.id, s); expect("short rest after a night", B, "rest after"); done = True
                break
    if done:
        break
assert done
# 5. two shifts on one day
r = P.residents[0]; bd = by_day(r.id, A); d = next(iter(bd))
s = next(s for s in P.slot_list if s.day == d and s.key != bd[d].key and s.min_pgy <= r.pgy)
B = copy.deepcopy(A); B[r.id] = B[r.id] + [s.key]; expect("two shifts on one day", B, "two shifts on")
# 6. work every day for nine days: breaks the 24h-off rule and the weekly hours cap
r = next(r for r in P.residents if not r.vacation and not r.chief_days and r.pgy >= 2)
B = copy.deepcopy(A); B[r.id] = [k for k in B[r.id] if not 8 <= P.slots[k].day <= 16]
for d in range(8, 17):
    B[r.id].append(min((s for s in P.slot_list if s.day == d and s.min_pgy <= r.pgy and s.dur >= 720), key=lambda s: s.start).key)
expect("nine straight days: no 24h break", B, "no 24h free of duty")
expect("nine straight long days: weekly hours", B, "h in the 7 days from")
expect("more shifts than contract", B, "contract maximum") if len(B[r.id]) > r.shifts_max else None
# 7. too many nights / runs
r = next(r for r in P.residents if not r.vacation and r.pgy >= 2 and not r.chief_days)
B = copy.deepcopy(A); B[r.id] = []
nights = [s for s in P.slot_list if P.is_night(s) and s.min_pgy <= r.pgy]
for d in (0, 1, 2, 5, 6, 7, 12, 13, 14, 20, 21, 22):
    B[r.id].append(next(s for s in nights if s.day == d).key)
expect("twelve nights in four runs (count)", B, "night shifts (limit")
expect("twelve nights in four runs (runs)", B, "separate runs of nights")
# 8. double-booked shift
s = P.slot_list[0]; B = copy.deepcopy(A)
extra = [r for r in P.residents if s.key not in B[r.id] and s.day not in by_day(r.id, B) and r.pgy >= s.min_pgy][0]
B[extra.id].append(s.key); expect("more residents than the shift allows", B, "at most")
# 9. academic time: a shift placed across it must be rejected for attendees
a = next(a for a in P.academic if a.day >= 0)
from cadence.problem import Shift
fake = Shift(("X", 0), "test shift", a.day, a.start - 60, a.start + 180, "day")
r = next(r for r in P.residents if a.day not in r.vacation)
assert any("academic" in v for v in validator.check_resident(P, r, [fake], check_min=False))
print("caught: shift overlapping academic time")
print("ALL VALIDATOR MUTATION TESTS PASSED")
