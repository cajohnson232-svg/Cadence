"""The previous interval's shifts can already break a weekly rule, and nothing in this interval can fix that.

Built like the case that prompted it (Kenneth Paul, Block 8): the last week of the previous interval was entered as
an evening, a swing and four nights in a row, with a Thursday conference in the only 24h gap. So the 7 days that
start six days before this interval have no 24 hours off whatever this interval does. The engine used to treat that
week as a rule it had to meet, could not, and left the person with no shifts at all (and the rule check still
reported the week as broken).

  1. the rule check no longer counts that week against this interval, and names it as a note instead;
  2. a week the previous interval did NOT already break is still checked (working this interval can still break it);
  3. the same for the 60-hour limit: hours already worked count, nothing more may be added, but it is not "broken";
  4. a full run gives the person their contract shifts and breaks no hard rule.

    python -m tests.test_past_week          (about 1 minute)
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
from cadence.generate import make_config
from cadence.problem import Problem
from cadence import validator
from cadence.report import past_notes

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RID = "r12"                                   # a PGY-3 with no previous-interval shifts in this generated program

cfg = make_config((8, 12), 12, seed=5)
cfg["history"] = [h for h in cfg["history"] if h["resident"] != RID]
pattern = [(-6, "14:00", "evening"), (-5, "14:00", "swing"), (-4, "22:00", "night"), (-3, "22:00", "night"),
           (-2, "22:00", "night"), (-1, "22:00", "night")]
cfg["history"] += [{"resident": RID, "day": d, "start": t, "hours": 8, "category": c, "name": f"prior {c}"}
                   for d, t, c in pattern]
cfg["academic_time"].append({"name": "Conference", "day": -4, "start": "08:00", "hours": 4, "if_shift_overlaps": "blocked"})

P = Problem(cfg)
r = P.by_id[RID]
assert validator.past_broken_weeks(P, r) == [-6], validator.past_broken_weeks(P, r)
v = validator.check_resident(P, r, P.hist[RID], check_min=False)
assert not any("24h free" in m for m in v), v
notes = past_notes(P)
assert len(notes) == 1 and r.name in notes[0], notes
print(f"1. the week from {P.label(-6)} is already without 24h off; not counted against this interval. Note: {notes[0]}")

# without the conference, the gap on day -4 is a real 24h break, so the week is fine and nothing is excused
cfg2 = copy.deepcopy(cfg)
cfg2["academic_time"].pop()
P2 = Problem(cfg2)
assert validator.past_broken_weeks(P2, P2.by_id[RID]) == []
# ...and a week that starts before the interval but is not already broken is still checked: fill days 0-5 with work
# for someone who worked days -2 and -1, so the week from day -1 has no 24h break
other = next(x for x in P.residents if x.id != RID and not P.hist[x.id] and not x.vacation and not x.chief_days and x.pgy == 3)
c3 = copy.deepcopy(cfg)
c3["history"] += [{"resident": other.id, "day": d, "start": "07:00", "hours": 8, "category": "day", "name": "prior day"} for d in (-2, -1)]
P3 = Problem(c3)
o = P3.by_id[other.id]
days = [next(s for s in P3.slot_list if s.day == d and s.cat == "evening" and P3.static_block_reason(o, s) is None) for d in range(0, 5)]
v = validator.check_resident(P3, o, P3.hist[o.id] + days, check_min=False)
assert any("24h free" in m for m in v), v
print(f"2. a week the previous interval had not already broken is still checked: {next(m for m in v if '24h free' in m)}")

# 60 hours: six 12h shifts before the interval are 72h in one week
c4 = copy.deepcopy(cfg)
c4["history"] += [{"resident": other.id, "day": d, "start": "07:00", "hours": 12, "category": "day", "name": "prior long day"}
                  for d in range(-7, -1)]
P4 = Problem(c4)
o = P4.by_id[other.id]
v = validator.check_resident(P4, o, P4.hist[o.id], check_min=False)
assert not any("h in the 7 days" in m for m in v), v
s0 = next(s for s in P4.slot_list if s.day == 0 and P4.static_block_reason(o, s) is None)
v = validator.check_resident(P4, o, P4.hist[o.id] + [s0], check_min=False)
assert any("h in the 7 days" in m for m in v), v
print(f"3. 72h already worked is not 'broken', but nothing more may go in that week: {next(m for m in v if 'h in the 7 days' in m)}")

with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "in.json")
    json.dump(cfg, open(p, "w"))
    subprocess.run([sys.executable, os.path.join(HERE, "run.py"), p, "--out", d, "--seconds", "60", "--polish-seconds", "10",
                    "--result", os.path.join(d, "r.json"), "--backend", "highs"], check=True, capture_output=True, cwd=HERE)
    res = json.load(open(os.path.join(d, "r.json")))
V = res["validator"]
me = next(x for x in res["residents"] if x["id"] == RID)
assert not V["hard_violations"], V["hard_violations"][:5]
assert me["shifts"] >= me["shifts_min"], (me["shifts"], me["shifts_min"])
assert res["past_notes"] and r.name in res["past_notes"][0]
print(f"4. full run: {r.name} works {me['shifts']} shifts (minimum {me['shifts_min']}), no hard rule broken, {V['open_shifts']} open")
print("ALL PAST-WEEK TESTS PASSED")
