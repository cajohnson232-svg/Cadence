"""Run one generated test scenario end to end and write its results.

    python run_tests.py TAG LENGTHS PER_DAY SEED [TIGHTNESS] [EXACT_SECONDS]
    e.g. python run_tests.py 8h+12h 8,12 32 5
"""
import json, os, sys, time
from cadence.problem import Problem, STAGES, DAY, clock
from cadence.generate import make_config
from cadence import solver, validator, report

tag, lengths, per_day, seed = sys.argv[1], tuple(int(x) for x in sys.argv[2].split(",")), int(sys.argv[3]), int(sys.argv[4])
tight = float(sys.argv[5]) if len(sys.argv) > 5 else 1.04
secs = float(sys.argv[6]) if len(sys.argv) > 6 else 240
os.makedirs("tests/configs", exist_ok=True); os.makedirs("results", exist_ok=True)
opts = sys.argv[7:]
cfg = make_config(lengths, per_day, seed=seed, tightness=tight, trim="trim" in opts, late_nights="late" in opts,
                  academic_policy="excused" if "excused" in opts else "blocked")
json.dump(cfg, open(f"tests/configs/{tag}.json", "w"), indent=1)
P = Problem(cfg)
lines = []
def say(m=""):
    print(m, flush=True); lines.append(m)

per = [sum(s.need for s in P.slot_list if s.day == d) for d in range(P.n_days)]
total = sum(per)
say(f"=== {tag}: {P.name} ===")
say(f"{len(P.residents)} residents, {total} shifts ({min(per)}-{max(per)} per day), shift lengths "
    f"{sorted({s.dur / 60 for s in P.slot_list})} h, staffing margin {sum(r.shifts_max for r in P.residents) / total - 1:+.1%}")
acad = [f"{P.label(a.day)} {clock(a.start)}-{clock(a.end)}" for a in P.academic if a.day >= 0]
say("Academic time: " + "; ".join(acad) + f"  [shift overlaps: {P.academic[0].policy}]")
late = sorted({f"{s.name} starts {clock(s.start)}" for s in P.slot_list if s.cal != s.day})
if late: say("Nights that start after midnight (count as the previous day): " + "; ".join(late))
errors, warnings = solver.precheck(P)
for e in errors: say("PRE-CHECK IMPOSSIBLE: " + e)
for w in warnings[:6]: say("pre-check warning: " + w)
if not errors and not warnings: say("Pre-check: inputs look feasible.")
t0 = time.time()
S = solver.Scheduler(P, log=say, seed=seed)
res = S.run(seconds=secs)
A = res["assignment"]
V, opens, short = validator.validate(P, A)
soft = validator.soft_metrics(P, A)
duty = validator.duty_stats(P, A)
n_open = sum(n for _, n in opens)
say(f"Validator: {len(V)} hard-rule violations, {n_open} open shifts, {len(short)} residents under contract minimum")
for v in V[:10]: say("  VIOLATION: " + v)
for line in solver.explain_open(P, A, limit=6): say("  OPEN: " + line)
say(f"Peak hours in any rolling 7 days: {duty['peak_rolling_7day_hours']:g} (limit {P.rules.max_week_minutes / 60:g}); "
    f"tightest rest margin: {duty['smallest_rest_margin_hours']:g}h beyond the required rest")
mism = []
for st, a, b, status in res["stages"][1:]:
    val = soft[st] / S.scale[st]
    if val > b + 1e-6: mism.append(st)
    say(f"  {st:<30} {val:>7.1f}   [{status}]")
if mism: say("  !! validator scores WORSE than solver believed for: " + ", ".join(mism))
say(f"Total time {time.time() - t0:.0f}s; exact sub-solves: {res['stats'].get('solves', 0)}; "
    f"moves rejected by the validator: {res['stats'].get('rejected by validator', 0)}")
# how often the nights exception was actually used: two shifts starting on one calendar date
same_date = sum(1 for keys in A.values() for c in [__import__('collections').Counter(P.slots[k].cal for k in keys)] for v in c.values() if v > 1)
excused_n = sum(1 for rid, keys in A.items() for a in P.academic if a.policy == "excused" and a.day >= 0
                and any(P.slots[k].start < a.block_to and a.block_from < P.slots[k].end for k in keys))
if late: say(f"Resident-days with two nights starting on the same calendar date: {same_date}")
if P.academic[0].policy == "excused": say(f"Times a resident was excused from academic time by a shift: {excused_n}")
facts = [f"{len(P.residents)} residents, {total} shifts ({min(per)}-{max(per)} per day)",
         f"Hard-rule violations (independent validator): {len(V)}; open shifts: {n_open}",
         f"Peak hours in any rolling 7 days: {duty['peak_rolling_7day_hours']:g}",
         "Academic time: " + "; ".join(acad)]
report.write_html(P, A, f"results/{tag}.html", f"Cadence test schedule: {P.name}", facts)
report.write_csv(P, A, f"results/{tag}.csv")
open(f"results/{tag}.txt", "w").write("\n".join(lines) + "\n")
json.dump({"tag": tag, "lengths": sorted({s.dur / 60 for s in P.slot_list}), "residents": len(P.residents), "shifts": total,
           "per_day": [min(per), max(per)], "margin": sum(r.shifts_max for r in P.residents) / total - 1,
           "decisions": res["decisions"], "academic": acad, "precheck_errors": errors, "violations": len(V),
           "open": n_open, "short": len(short), "duty": duty, "seconds": time.time() - t0,
           "soft": {st: soft[st] / S.scale[st] for st in STAGES[1:]}, "stages": res["stages"],
           "solves": res["stats"].get("solves", 0), "model_validator_mismatch": mism,
           "rejected_by_validator": res["stats"].get("rejected by validator", 0), "academic_policy": P.academic[0].policy,
           "late_nights": bool(late), "two_nights_one_date": same_date, "excused": excused_n},
          open(f"results/{tag}.json", "w"), indent=1)
