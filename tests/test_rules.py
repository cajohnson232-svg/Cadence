"""Tests for the two rules confirmed on 13 Nov: the nights exception to one-shift-per-day,
and the admin setting for shifts that overlap academic time.

    python -m tests.test_rules
"""
import copy
from cadence.problem import Problem, DAY, clock
from cadence.generate import make_config
from cadence import validator

check = lambda P, r, shifts: validator.check_resident(P, r, shifts, check_min=False)   # noqa: E731

# ---- one shift per day, except a series of nights that crosses two calendar days ----------
P = Problem(make_config((8,), 12, seed=31, late_nights=True))
r = next(r for r in P.residents if r.pgy == 3 and not r.chief_days and not r.vacation and not P.hist[r.id]
         and not r.mandatory_off)
overnight = [s for s in P.slot_list if s.cal != s.day]            # starts just after midnight
evening_night = [s for s in P.slot_list if P.is_night(s) and s.cal == s.day]
assert overnight and evening_night
d = 9
a = next(s for s in overnight if s.day == d)                      # belongs to day 9, starts 00:00 on day 10
b = next(s for s in evening_night if s.day == d + 1)              # belongs to day 10, starts that evening
assert a.cal == b.cal, "both start on the same calendar date"
assert not check(P, r, [a, b]), check(P, r, [a, b])
print(f"allowed:  back-to-back nights starting {P.label(a.cal)} {clock(a.start)} and {P.label(b.cal)} {clock(b.start)} "
      f"(two starts on one calendar date)")
c = next(s for s in evening_night if s.day == d - 1)              # ordinary night the evening before
run = [c, a, b]
assert not check(P, r, run), check(P, r, run)
soft = validator.soft_resident(P, r, run, P.balance_share())
assert soft["extra / over-long night runs"] == 0 and soft["backward rotations"] == 0
print("allowed:  three nights in a row mixing both kinds, counted as ONE run of nights")
day_shift = next(s for s in P.slot_list if s.day == d and not P.is_night(s) and s.min_pgy <= r.pgy)
v = check(P, r, [day_shift, a])
assert any("two shifts" in m for m in v), v
print(f"rejected: a {day_shift.cat} shift plus the overnight that belongs to the same day -> {v[0]}")
two_days = [s for s in P.slot_list if s.day == d and not P.is_night(s) and s.min_pgy <= r.pgy][:2]
assert any("two shifts" in m for m in check(P, r, two_days))
print("rejected: two non-night shifts on one day")
e = next(s for s in P.slot_list if s.day == d + 1 and not P.is_night(s) and s.start - a.end < a.dur and s.start >= a.end
         and s.min_pgy <= r.pgy and P.static_block_reason(r, s) is None)
v = check(P, r, [a, e])
assert any("rest after" in m for m in v), v
print(f"rejected: a {e.cat} shift too soon after the overnight ends -> {v[0]}")

# ---- academic time: the admin decides what happens to an overlapping shift ---------------
cfg = make_config((8,), 12, seed=32, academic_policy="excused")
P = Problem(cfg)
ses = next(a for a in P.academic if a.day >= 0)
r = next(r for r in P.residents if ses.day not in r.vacation and not r.chief_days and not P.hist[r.id])
s = next(s for s in P.slot_list if s.start < ses.block_to and ses.block_from < s.end and s.min_pgy <= r.pgy)
assert P.static_block_reason(r, s) is None and not check(P, r, [s])
print(f'"excused": {r.name} may work {s.name} across academic time on {P.label(ses.day)} and is excused from the session')
cfg2 = copy.deepcopy(cfg)
for a in cfg2["academic_time"]:
    a["if_shift_overlaps"] = "blocked"
P2 = Problem(cfg2)
r2, s2 = P2.by_id[r.id], P2.slots[s.key]
assert P2.static_block_reason(r2, s2) == "academic time" and any("academic" in m for m in check(P2, r2, [s2]))
print('"blocked": the same shift is refused for anyone who attends')
cfg3 = copy.deepcopy(cfg)
cfg3["academic_time"] = [dict(a, if_shift_overlaps="blocked" if i % 2 else "excused") for i, a in enumerate(cfg["academic_time"])]
P3 = Problem(cfg3)
print("per-session setting accepted:", sorted({a.policy for a in P3.academic}))
# a session that is actually attended counts as duty for the 24h-off rule
cfg4 = copy.deepcopy(cfg); cfg4["academic_time"] = []
P4 = Problem(cfg4)
ok = lambda s: s.min_pgy <= r.pgy and s.cal == s.day and not P.is_night(s)        # noqa: E731
shown = False
for ses in [a for a in P.academic if 4 <= a.day <= P.n_days - 5]:
    q = ses.day
    late = [max((s for s in P.slot_list if s.day == dd and ok(s)), key=lambda s: s.end) for dd in (q - 3, q - 2, q - 1)]
    early = [min((s for s in P.slot_list if s.day == dd and ok(s)), key=lambda s: s.start) for dd in (q + 1, q + 2, q + 3)]
    if early[0].start - ses.end >= DAY or ses.start - late[-1].end >= DAY or check(P4, P4.by_id[r.id], [P4.slots[s.key] for s in late + early]):
        continue
    v = check(P, r, late + early)
    assert any("no 24h free" in m for m in v), v
    print("24h rule: three late shifts, an ATTENDED session, three early shifts ->", [m for m in v if "24h" in m][0],
          "(legal without the session)")
    shown = True
    break
assert shown
print("ALL RULE TESTS PASSED")
