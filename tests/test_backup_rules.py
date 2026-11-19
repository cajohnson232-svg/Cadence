"""Backup rules: each one is kept by the backup optimisation, and its separate checker catches each one when broken.

    python -m tests.test_backup_rules          (under a minute)
"""
import copy
from cadence.generate import make_config
from cadence.problem import Problem
from cadence import backup, solver

cfg = make_config((8, 12), 12, seed=5)
P0 = Problem(cfg)
A = solver.greedy(P0)
seniors = [r["id"] for r in cfg["residents"] if r["pgy"] >= 2]


def run(rules, eligible=None):
    c = copy.deepcopy(cfg)
    c["backup"] = [{"name": "Backup", "ref": "bk", "site": "", "category": cfg["shift_templates"][0]["category"], "start": "07:00", "hours": 24,
                    "weekdays": list(range(7)), "headcount": 1, "eligible": eligible or seniors, "rules": rules}]
    P = Problem(c)
    R = backup.assign(P, A, seconds=30)
    return P, R


def nights_on(P, rid, day):
    return any(P.is_night(P.slots[k]) and P.slots[k].day == day for k in A[rid]) or any(P.is_night(s) and s.day == day for s in P.hist[rid])


# 1. not the day after / before a night shift, not next to vacation
P, R = run({"not_after_night": True, "not_before_night": True, "not_next_to_vacation": True, "max_per_person": None})
assert not backup.check(P, A, R), backup.check(P, A, R)[:5]
on = [(rid, e["day"]) for e in R["days"] for rid in e["assigned"]]
assert on, "some backup days were filled"
assert not any(nights_on(P, rid, d - 1) for rid, d in on), "backup the day after a night"
assert not any(nights_on(P, rid, d + 1) for rid, d in on), "backup the day before a night"
assert not any((d - 1) in P.by_id[rid].vacation or (d + 1) in P.by_id[rid].vacation for rid, d in on), "backup next to vacation"
print(f"kept: not after or before a night, not next to vacation ({len(on)} backup days filled, {len(R['open'])} open)")

# 2. the checker catches each of them when broken (move one backup day onto a forbidden day)
P2, R2 = run({"max_per_person": None})
for rule, bad_day, word in [("not_after_night", lambda rid: next((d + 1 for d in range(P2.n_days - 1) if nights_on(P2, rid, d)), None), "the day after"),
                            ("not_before_night", lambda rid: next((d - 1 for d in range(1, P2.n_days) if nights_on(P2, rid, d)), None), "the day before"),
                            ("not_next_to_vacation", lambda rid: next((d - 1 for d in sorted(P2.by_id[rid].vacation) if d - 1 >= 0 and d - 1 not in P2.by_id[rid].vacation), None), "next to vacation")]:
    c = copy.deepcopy(P2.cfg); c["backup"][0]["rules"][rule] = True
    Pc = Problem(c)
    rid, d = next((rid, bad_day(rid)) for rid in seniors if bad_day(rid) is not None)
    fake = {"days": [{"line": 0, "name": "Backup", "day": d, "start": d * 1440 + 420, "end": d * 1440 + 420 + 1440, "need": 1, "assigned": [rid]}]}
    v = backup.check(Pc, A, fake)
    assert any(word in m for m in v), (rule, v)
print("caught: a backup day after a night, before a night, and next to vacation")

# 3. a minimum per person is aimed for, and a maximum still holds
P3, R3 = run({"min_per_person": 1, "max_per_person": 3})
assert not backup.check(P3, A, R3), backup.check(P3, A, R3)[:5]
per = R3["per_resident"]
assert all(per.get(rid, 0) <= 3 for rid in seniors)
low = [rid for rid in seniors if per.get(rid, 0) < 1]
assert len(low) == len(R3["below_minimum"]), (low, R3["below_minimum"])
print(f"minimum 1 each: {len(seniors) - len(low)} of {len(seniors)} eligible people have at least one; "
      f"{len(R3['below_minimum'])} listed as below it; none above 3")
assert len(low) <= max(0, len(seniors) - sum(1 for e in R3["days"] if e["assigned"])), "someone was left at 0 while others had more than one"
print("ALL BACKUP RULE TESTS PASSED")
