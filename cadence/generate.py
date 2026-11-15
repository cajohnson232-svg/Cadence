"""Random admin-style configurations for testing.

This plays the role of the administrator: it invents shift templates (start
times, lengths, headcounts), weekly academic time, residents, contracts,
vacations and prior-block history, and writes them as the same JSON the real
application would hand to the solver. Nothing here is used by the solver.
"""
from __future__ import annotations
import random

SURNAMES = """Adams Baker Chen Diaz Evans Flores Garcia Hall Iyer Jones Kim Lopez Morris Nguyen Okafor Patel Quinn
Reyes Singh Tran Usman Vega Walker Xu Young Zhang Abbott Brooks Castro Dunn Ellis Foster Grant Hughes Ito James
Khan Lewis Mills Novak Ortiz Park Rossi Stone Torres Udoka Vance Wolfe Yates Zimmer Ahmed Bell Cruz Drake Engel
Ford Gomez Hart Irwin Jain Kemp Lang Mora Nash Owens Price Reed Shah Tate Unger Voss Webb York Zane Avery Blake
Cole Dean Eaton Frost Gill Hale""".split()

# (category, earliest start hour, latest start hour, share of the pod's shifts)
PLANS = {
    8: [("day", 6, 8, .30), ("evening", 13, 15, .25), ("swing", 16, 19, .15), ("night", 21, 23, .30)],
    10: [("day", 6, 8, .30), ("evening", 11, 14, .25), ("swing", 15, 17, .15), ("night", 20, 22, .30)],
    12: [("day", 6, 8, .40), ("evening", 10, 12, .25), ("night", 18, 20, .35)],
}
PODS = [("MHH", "T", 2), ("MHH", "M", 1), ("LBJ", "GP", 1), ("LBJ", "CC", 1)]   # (site, pod, min PGY)


def hhmm(m):
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def make_config(lengths=(8,), per_day=32, seed=0, tightness=1.04, n_days=28, start_date="2027-01-04", trim=False,
                late_nights=False, academic_policy="blocked"):
    """late_nights: half of the night lines start just after midnight instead of late evening.
    academic_policy: "blocked" (admin moves overlapping shifts to start after the session) or
    "excused" (overlapping shifts stay; whoever works one is excused from the session)."""
    rng = random.Random(seed)
    lengths = list(lengths)
    templates = []
    pod_len = [lengths[i % len(lengths)] for i in range(len(PODS))]
    rng.shuffle(pod_len)
    base, extra = divmod(per_day, len(PODS))
    for p, (site, pod, min_pgy) in enumerate(PODS):
        L, n = pod_len[p], base + (1 if p < extra else 0)
        plan = PLANS[L]
        counts = [max(1, int(n * w)) for *_, w in plan]
        while sum(counts) < n:
            counts[rng.randrange(len(plan))] += 1
        while sum(counts) > n:
            i = max(range(len(plan)), key=lambda q: counts[q])
            counts[i] -= 1
        for (cat, lo, hi, _), c in zip(plan, counts):
            start = rng.randrange(lo * 2, hi * 2 + 1) * 30
            templates.append({"name": f"{site} {pod} {cat} {L}h", "site": site, "pod": pod, "category": cat,
                              "start": hhmm(start), "hours": L, "headcount": c, "min_pgy": min_pgy,
                              "weekdays": list(range(7))})
    L = lengths[0]                                           # a weekday-only extra line
    start = rng.randrange(9 * 2, 11 * 2 + 1) * 30
    templates.append({"name": f"MHH M fast-track {L}h", "site": "MHH", "pod": "M", "category": "day" if start < 600 else "evening",
                      "start": hhmm(start), "hours": L, "headcount": 2, "min_pgy": 1, "weekdays": [0, 1, 2, 3, 4]})

    if late_nights:
        # With protected ("blocked") academic time only 8h nights can start at midnight and still
        # finish before the earliest session; with "excused" any night line may start late.
        lines = [t for t in templates if t["category"] == "night" and (academic_policy == "excused" or t["hours"] == 8)]
        for t in lines[::2] or lines:
            t["start"] = "00:00" if academic_policy == "blocked" else rng.choice(["00:00", "00:30", "01:00"])
            t["name"] = t["name"].replace("night", "overnight")
            t["counts_as_previous_day"] = True

    # Academic time: same weekday every week, 2-4h, at a different business-hours time each week.
    wd = rng.randrange(5)
    first = (wd - __import__("datetime").date.fromisoformat(start_date).weekday()) % 7
    academic = []
    for d in range(first - 7, n_days, 7):
        dur = rng.choice([120, 150, 180, 210, 240])
        st = rng.randrange(8 * 2, (17 * 60 - dur) // 30 + 1) * 30
        academic.append({"name": "Academic time", "day": d, "start": hhmm(st), "hours": dur / 60,
                         "if_shift_overlaps": academic_policy})
    # The admin's special-staffing override for those dates: any shift that would overlap
    # academic time starts when it ends instead (same length).
    for a in academic:
        d = a["day"]
        if d < 0 or academic_policy != "blocked":
            continue
        a0 = int(a["start"][:2]) * 60 + int(a["start"][3:]); a1 = a0 + int(a["hours"] * 60)
        for t in list(templates):
            if t.get("counts_as_previous_day"):
                continue                      # midnight-start 8h nights end before any session begins
            if "only_days" in t or (d % 7 + __import__("datetime").date.fromisoformat(start_date).weekday()) % 7 not in t["weekdays"]:
                continue
            s0 = int(t["start"][:2]) * 60 + int(t["start"][3:]); s1 = s0 + int(t["hours"] * 60)
            if s0 < a1 and a0 < s1:
                t.setdefault("except_days", []).append(d)
                moved = dict(t, name=t["name"] + " (after academic)", start=hhmm(a1), only_days=[d])
                moved.pop("except_days", None); moved.pop("weekdays", None)
                if t["category"] == "day" and a1 >= 600:
                    moved["category"] = "evening"
                templates.append(moved)

    # Demand, then just enough residents to cover it ("minimal coverage").
    import datetime
    wd0 = datetime.date.fromisoformat(start_date).weekday()
    demand = minutes = 0
    for t in templates:
        days = t["only_days"] if "only_days" in t else [d for d in range(n_days)
                                                        if (wd0 + d) % 7 in t["weekdays"] and d not in t.get("except_days", [])]
        demand += len(days) * t["headcount"]
        minutes += len(days) * t["headcount"] * t["hours"] * 60
    mean_h = minutes / demand / 60
    target = {1: 172, 2: 162, 3: 152}
    residents, supply, chiefs = [], 0, 0
    names = SURNAMES[:]
    rng.shuffle(names)
    while supply < demand * tightness:
        i = len(residents)
        pgy = 1 + i % 3
        mx = round(target[pgy] / mean_h)
        r = {"id": f"r{i + 1:02d}", "name": names[i % len(names)] + ("" if i < len(names) else str(i // len(names) + 1)),
             "pgy": pgy, "chief_days": False, "vacation": [], "mandatory_off": [], "requests_off": {}}
        if pgy == 3 and chiefs < 2:
            r["chief_days"] = True; chiefs += 1; mx -= 3
        elif rng.random() < 0.12:
            k = rng.randrange(5, 8); a = rng.randrange(0, n_days - k)
            r["vacation"] = list(range(a, a + k)); mx = round(mx * (1 - k / n_days))
        if rng.random() < 0.06:
            r["mandatory_off"] = [rng.choice([d for d in range(n_days) if d not in r["vacation"]])]
        if rng.random() < 0.30:
            for d in rng.sample([d for d in range(n_days) if d not in r["vacation"]], rng.randrange(1, 4)):
                r["requests_off"][str(d)] = rng.randrange(1, 4)
        r["shifts_max"], r["shifts_min"] = mx, max(0, mx - 2)
        residents.append(r); supply += mx

    if trim:        # shave contracts so capacity is exactly demand x tightness (no rounding-up slack)
        excess, i = supply - int(-(-demand * tightness // 1)), len(residents) - 1
        while excess > 0 and i >= 0:
            cut = min(excess, 2)
            residents[i]["shifts_max"] -= cut
            residents[i]["shifts_min"] = max(0, residents[i]["shifts_max"] - 2)
            excess -= cut; i -= 1

    # Prior-block history for about a third of residents.
    history = []
    weekly = [t for t in templates if "only_days" not in t and len(t["weekdays"]) == 7 and not t.get("counts_as_previous_day")]
    for r in residents:
        if rng.random() < 0.30:
            kind = rng.choice(["night", "day"])
            pool = [t for t in weekly if t["category"] == kind and t["min_pgy"] <= r["pgy"]]
            if not pool:
                continue
            t = rng.choice(pool)
            k = rng.randrange(2, 4) if kind == "night" else rng.randrange(3, 5)
            last = -1 if kind == "night" else rng.choice([-1, -2])
            for d in range(last - k + 1, last + 1):
                history.append({"resident": r["id"], "day": d, "start": t["start"], "hours": t["hours"],
                                "category": t["category"], "name": t["name"]})
    label = "+".join(f"{x}h" for x in sorted(set(lengths)))
    return {
        "name": f"{label} block, {per_day}+ shifts/day (seed {seed})", "start_date": start_date, "n_days": n_days,
        "category_order": ["day", "evening", "swing", "night"], "night_categories": ["night"],
        "balance_groups": {"day": "day", "evening": "evening", "swing": "evening", "night": "night"},
        "pod_pairs": [["MHH", "T", "M"], ["LBJ", "GP", "CC"]],
        "chief_time": [{"weekday": 3, "start": "00:00", "hours": 13}],
        "rules": {"max_week_hours": 60, "rest_ratio": 1.0, "max_nights": 8, "max_night_runs": 2,
                  "min_gap_between_night_runs": 7, "max_night_fraction_pct": 45, "soft_max_nights_in_run": 6,
                  "history_days": 7},
        "shift_templates": templates, "academic_time": academic, "residents": residents, "history": history,
    }
