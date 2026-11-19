"""Optional places: a shift's maximum headcount above its minimum, used only to get people to their contract minimum.

Built like the case that prompted it: two LBJ shifts that need 1 person but can take 2 (an evening and a night,
like "Gold Pod Evening" and "Gold Pod Night"), and a "Dugout" shift that needs nobody, can take 1, and only PGY-3s
may work. Every resident's contract minimum is raised to their maximum, so the required places alone cannot give
everyone their minimum.

  1. without the optional places, the engine must leave people short (the required places are too few);
  2. with them, nobody is short, no hard rule is broken, every required place is filled, and the optional places
     used are exactly the shortfall that had to be made up (no more: the goal right after contract shortfall);
  3. Dugout is worked by PGY-3s only, and PGY-1s and PGY-2s are not left short either;
  4. with ordinary contract minimums, no optional place is used at all.

    python -m tests.test_optional_places          (about 4 minutes)
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
from cadence.generate import make_config

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cfg, seconds=60):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "in.json")
        json.dump(cfg, open(p, "w"))
        subprocess.run([sys.executable, os.path.join(HERE, "run.py"), p, "--out", d, "--seconds", str(seconds), "--polish-seconds", "10",
                        "--result", os.path.join(d, "r.json"), "--backend", "highs"], check=True, capture_output=True, cwd=HERE)
        return json.load(open(os.path.join(d, "r.json")))


base = make_config((8, 12), 12, seed=5)
pgy = {r["id"]: r["pgy"] for r in base["residents"]}
tight = copy.deepcopy(base)
for r in tight["residents"]:
    r["shifts_min"] = r["shifts_max"]                     # everyone must reach their maximum

flex = copy.deepcopy(tight)
for t in flex["shift_templates"]:
    if t["name"] in ("LBJ GP evening 12h", "LBJ GP night 12h"):
        t["max_headcount"] = 2
dug = next(t for t in base["shift_templates"] if t["name"] == "LBJ GP day 12h")
flex["shift_templates"].append({**dug, "name": "LBJ Dugout 10h", "hours": 10, "headcount": 0, "max_headcount": 1, "min_pgy": 3, "ref": "dugout"})

r0 = run(tight)
need = r0["validator"]["total_shifts"]
want = sum(r["shifts_min"] for r in tight["residents"]) - need
short0 = sum(max(0, p["shifts_min"] - p["shifts"]) for p in r0["residents"])
print(f"required places {need}, contract minimums add up to {need + want}: {want} more than there are places")
assert want > 0
assert short0 >= want, (short0, want)
print(f"1. without optional places: {short0} shift(s) short of contract minimums (at least {want} had to be)")

r1 = run(flex, seconds=90)
V = r1["validator"]
short1 = sum(max(0, p["shifts_min"] - p["shifts"]) for p in r1["residents"])
assert not V["hard_violations"], V["hard_violations"][:5]
assert V["open_shifts"] == 0, V["open_shifts"]
assert short1 == 0, [(p["name"], p["shifts"], p["shifts_min"]) for p in r1["residents"] if p["shifts"] < p["shifts_min"]]
assert V["extra_places_used"] == want, (V["extra_places_used"], want)
goal = next(g for g in r1["goals"] if g["name"] == "extra places used")
assert goal["score"] == want, goal
print(f"2. with them: nobody short, 0 hard-rule violations, 0 open, {V['extra_places_used']} optional place(s) used = exactly the gap")

dugout = [a for s in r1["slots"] if s["ref"] == "dugout" for a in s["assigned"]]
extra_lbj = sum(max(0, len(s["assigned"]) - s["need"]) for s in r1["slots"] if s["name"] in ("LBJ GP evening 12h", "LBJ GP night 12h"))
assert all(pgy[a] == 3 for a in dugout), [pgy[a] for a in dugout]
assert all(len(s["assigned"]) <= s["max"] for s in r1["slots"])
junior_short = [p["name"] for p in r1["residents"] if pgy[p["id"]] < 3 and p["shifts"] < p["shifts_min"]]
assert not junior_short, junior_short
print(f"3. Dugout worked {len(dugout)} time(s), all by PGY-3s; {extra_lbj} second person(s) on the two LBJ shifts; no PGY-1 or PGY-2 short")

easy = copy.deepcopy(flex)
for r, b in zip(easy["residents"], base["residents"]):
    r["shifts_min"] = b["shifts_min"]
r2 = run(easy)
assert not r2["validator"]["hard_violations"] and r2["validator"]["open_shifts"] == 0
assert r2["validator"]["extra_places_used"] == 0, r2["validator"]["extra_places_used"]
print("4. with ordinary contract minimums: no optional place used")
print("ALL OPTIONAL-PLACE TESTS PASSED")
