import json, os
order = [l.split()[0] for l in open("matrix.txt") if l.strip()]
rows = [json.load(open(f"results/{t}.json")) for t in order if os.path.exists(f"results/{t}.json")]
cols = ["backward rotations", "day/evening/night balance", "night runs too close", "nights into vacation",
        "night share over limit", "pod balance", "isolated days off", "extra / over-long night runs", "requests off missed"]
out = ["| Scenario | Residents | Shifts (per day) | Staffing margin | Open | Hard violations | Under contract min | Peak 7-day hours | "
       + " | ".join(c.capitalize() for c in cols) + " | Time |", "|" + "---|" * (9 + len(cols))]
for r in rows:
    out.append(f"| {r['tag']} | {r['residents']} | {r['shifts']} ({r['per_day'][0]}-{r['per_day'][1]}) | {r['margin']:+.1%} | {r['open']} | "
               f"{r['violations']} | {r['short']} | {r['duty']['peak_rolling_7day_hours']:g} | "
               + " | ".join(f"{r['soft'][c]:g}" for c in cols) + f" | {r['seconds'] / 60:.1f} min |")
open("results/summary.md", "w").write("\n".join(out) + "\n")
print("\n".join(out))
for r in rows:
    if r["model_validator_mismatch"] or r["precheck_errors"]:
        print(r["tag"], "mismatch:", r["model_validator_mismatch"], "precheck:", r["precheck_errors"][:3])
