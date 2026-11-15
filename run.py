"""Schedule one block from an admin configuration file.

    python run.py tests/configs/8h+12h.json --out out --seconds 600
    python run.py my_block.json --backend cpsat --strategy full     # OR-Tools CP-SAT, whole program at once
    python run.py my_block.json --result result.json --progress progress.json     # how the web app calls it

--result writes everything about the schedule as JSON (who works what, open shifts and why, the
independent rule check, goal scores, per-person figures). --progress is rewritten at the start of
every phase so a caller can show what the engine is doing. Both are written to a temporary file and
renamed, so a reader never sees half a file.
"""
import argparse, json, os, time
from cadence.problem import Problem, STAGES
from cadence import solver, validator, report

ap = argparse.ArgumentParser()
ap.add_argument("config")
ap.add_argument("--out", default="out")
ap.add_argument("--seconds", type=float, default=420, help="time for the exact optimisation")
ap.add_argument("--polish-seconds", type=float, default=60)
ap.add_argument("--backend", default="auto", choices=["auto", "highs", "cpsat"])
ap.add_argument("--strategy", default="auto", choices=["auto", "full", "lns"])
ap.add_argument("--result", help="write the full result as JSON to this file")
ap.add_argument("--progress", help="keep this JSON file updated with the current phase")
a = ap.parse_args()
T0 = time.time()


def put(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def progress(phase, **info):
    if a.progress:
        put(a.progress, {"phase": phase, "elapsed": round(time.time() - T0, 1), **info})


progress("reading")
P = Problem.load(a.config)
os.makedirs(a.out, exist_ok=True)
progress("capacity check")
errors, warnings = solver.precheck(P)
for e in errors: print("PRE-CHECK IMPOSSIBLE:", e)
for w in warnings: print("pre-check warning:", w)
S = solver.Scheduler(P, backend=a.backend, progress=progress)
res = S.run(strategy=a.strategy, seconds=a.seconds, polish_seconds=a.polish_seconds)
A = res["assignment"]
progress("rule check")
V, opens, short = validator.validate(P, A)
n_open = sum(n for _, n in opens)
print(f"Validator: {len(V)} hard-rule violations, {n_open} open shifts, {len(short)} under contract minimum")
for v in V: print("  VIOLATION:", v)
for line in solver.explain_open(P, A): print("  OPEN:", line)
duty = validator.duty_stats(P, A)
report.write_csv(P, A, f"{a.out}/schedule.csv")
report.write_html(P, A, f"{a.out}/schedule.html", P.name,
                  [f"Hard-rule violations: {len(V)}; open shifts: {n_open}",
                   f"Peak hours in any rolling 7 days: {duty['peak_rolling_7day_hours']:g}"])
print(f"Wrote {a.out}/schedule.csv and {a.out}/schedule.html")
progress("done")
if a.result:      # written last: a caller may clear the folder as soon as this file appears
    put(a.result, report.result(P, res, V, opens, short, errors, warnings, solver.open_details(P, A)))
    print(f"Wrote {a.result}")
