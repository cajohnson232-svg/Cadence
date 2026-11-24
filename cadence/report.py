"""Schedule exports: CSV, a colour grid (HTML), and the machine-readable result the web app imports."""
from __future__ import annotations
import csv
import html
from collections import defaultdict
from .problem import Problem, DAY, STAGES, clock
from . import validator

COL = {0: "#fde68a", 1: "#fdba74", 2: "#f9a8d4", 3: "#a5b4fc"}


def write_csv(P: Problem, assignment, path):
    who = defaultdict(list)
    for rid, keys in assignment.items():
        for k in keys:
            who[k].append(P.by_id[rid])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "shift", "site", "pod", "category", "start", "end", "hours", "resident", "pgy"])
        for s in P.slot_list:
            people = who[s.key] + [None] * (s.need - len(who[s.key]))
            for r in people:
                w.writerow([P.date(s.cal), s.name, s.site, s.pod, s.cat, clock(s.start), clock(s.end), s.dur / 60,
                            r.name if r else "OPEN", r.pgy if r else ""])


def write_html(P: Problem, assignment, path, title, facts):
    acad = defaultdict(list)
    for a in P.academic:
        acad[a.day].append(a)
    head = "<tr><th>Resident</th><th>Shifts</th><th>Hours</th>" + "".join(
        f"<th class='{'we' if P.weekday(d) >= 5 else ''}{' ac' if d in acad else ''}'>{P.label(d).replace(' ', '<br>')}"
        + "".join(f"<br><small>{clock(a.start)}&ndash;{clock(a.end)}</small>" for a in acad.get(d, [])) + "</th>"
        for d in range(P.n_days)) + "</tr>"
    rows = [head]
    for r in P.residents:
        mine = {P.slots[k].day: P.slots[k] for k in assignment.get(r.id, ())}
        cells = []
        for d in range(P.n_days):
            s = mine.get(d)
            if s:
                tip = html.escape(f"{s.name}  {P.label(s.cal)} {clock(s.start)}-{clock(s.end)}")
                cells.append(f"<td style='background:{COL.get(P.cat_order[s.cat], '#e5e7eb')}' title='{tip}'>"
                             f"{s.cat[0].upper()}{s.dur / 60:g}</td>")
            elif d in r.vacation:
                cells.append("<td class='vac'>VAC</td>")
            elif d in r.mandatory_off:
                cells.append("<td class='vac'>OFF</td>")
            elif d in r.requests_off:
                cells.append("<td class='req'>req</td>")
            else:
                cells.append("<td></td>")
        hrs = sum(s.dur for s in mine.values()) / 60
        rows.append(f"<tr><th>{html.escape(r.name)} <small>PGY-{r.pgy}{' chief' if r.chief_days else ''}</small></th>"
                    f"<td>{len(mine)}</td><td>{hrs:g}</td>{''.join(cells)}</tr>")
    key = "".join(f"<span style='background:{COL[i]}'>{c[0].upper()} = {c}</span>" for c, i in P.cat_order.items())
    open(path, "w").write(f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>
body{{font:13px system-ui,sans-serif;margin:20px;color:#1f2937}} table{{border-collapse:collapse}}
th,td{{border:1px solid #d1d5db;padding:2px 4px;text-align:center;min-width:30px;font-size:11px}}
th:first-child{{text-align:left;white-space:nowrap;position:sticky;left:0;background:#fff}}
small{{color:#6b7280;font-weight:400;font-size:9px}} .we{{background:#f3f4f6}} .ac{{background:#dbeafe}}
.vac{{background:#d1d5db;font-size:9px}} .req{{color:#9ca3af;font-size:9px}}
.k span{{display:inline-block;padding:2px 8px;margin-right:6px;border-radius:3px}} li{{margin:2px 0}}</style></head><body>
<h2>{html.escape(title)}</h2><ul>{''.join(f'<li>{html.escape(x)}</li>' for x in facts)}</ul>
<p class="k">{key} Number = shift length in hours. Blue column headers = academic time that day. Hover a cell for the shift.
A night that starts after midnight is shown under the day it belongs to (the evening before).</p>
<div style="overflow-x:auto"><table>{''.join(rows)}</table></div></body></html>""")


def result(P: Problem, run, violations, opens, short, pre_errors, pre_warnings, open_info, backup=None):
    """Everything a caller needs to store and show a schedule, as plain JSON-able data.

    All figures here come from the independent validator and the clock times, not from the solver's model.
    Times are minutes from 00:00 on day 0 of the block; `day` is the day a shift belongs to and
    `cal` the calendar day it starts on (they differ for a night that starts after midnight)."""
    A = run["assignment"]
    who = defaultdict(list)
    for rid, keys in A.items():
        for k in keys:
            who[k].append(rid)
    slots = []
    for s in P.slot_list:
        t = P.templates[s.key[1]]
        slots.append({"day": s.day, "cal": s.cal, "template": s.key[1], "ref": s.ref, "special_ref": t.get("special_ref"),
                      "name": s.name, "site": s.site, "pod": s.pod, "category": s.cat, "start": s.start, "end": s.end,
                      "need": s.need, "max": s.cap, "assigned": sorted(who.get(s.key, []))})
    share = P.balance_share()
    people = []
    for r in P.residents:
        shifts = validator.worked(P, r, A)
        cur = [s for s in shifts if not s.hist]
        peak = 0
        for t in {s.start for s in shifts} | {s.end - 7 * DAY for s in shifts}:
            if t + 7 * DAY <= 0 or t < -P.rules.history_days * DAY:
                continue
            peak = max(peak, sum(max(0, min(s.end, t + 7 * DAY) - max(s.start, t)) for s in shifts))
        people.append({
            "id": r.id, "name": r.name, "shifts": len(cur), "shifts_min": r.shifts_min, "shifts_max": r.shifts_max,
            "hours": sum(s.dur for s in cur) / 60, "nights": sum(1 for s in cur if s.cat in P.night_cats),
            "weekend_shifts": sum(1 for s in cur if P.weekday(s.cal) >= 5),
            "peak_rolling_7day_hours": peak / 60,
            "requests_off_missed": sorted({s.cal for s in cur if s.cal in r.requests_off}),
            "goals": {k: v for k, v in validator.soft_resident(P, r, shifts, share).items() if v}})
    soft = validator.soft_metrics(P, A)
    scale = {"day/evening/night balance": 10.0, "site split": 100.0}
    stage = {name: (first, last, status) for name, first, last, status in run["stages"]}
    goals = [{"name": g, "score": (float(sum(n for _, n in opens)) if g == "open shifts" else soft.get(g, 0) / scale.get(g, 1.0)),
              "start": stage.get(g, (0, 0, ""))[0], "status": stage.get(g, (0, 0, "optimal"))[2]} for g in STAGES]
    return {
        "version": 1, "name": P.name, "start_date": P.start_date.isoformat(), "n_days": P.n_days,
        "engine": {"backend": run["backend"], "strategy": run["strategy"], "seconds": round(run["seconds"], 1),
                   "decisions": run["decisions"]},
        "precheck": {"errors": list(pre_errors), "warnings": list(pre_warnings)},
        "past_notes": past_notes(P),
        "validator": {"hard_violations": list(violations), "open_shifts": sum(n for _, n in opens),
                      "total_shifts": sum(s.need for s in P.slot_list), "under_contract_minimum": list(short),
                      "optional_places": sum(s.cap - s.need for s in P.slot_list), "extra_places_used": validator.extra_places(P, A)},
        "duty": validator.duty_stats(P, A),
        "goals": goals,
        "open": [{"day": o["shift"].day, "cal": o["shift"].cal, "template": o["shift"].key[1], "name": o["shift"].name,
                  "site": o["shift"].site, "start": o["shift"].start, "end": o["shift"].end, "need": o["shift"].need,
                  "missing": o["missing"], "reasons": o["reasons"]} for o in open_info],
        "residents": people, "slots": slots, "backup": backup}


def past_notes(P):
    """People whose previous-interval shifts already leave a week without 24h off (nothing here can fix it)."""
    out = []
    for r in P.residents:
        weeks = validator.past_broken_weeks(P, r)
        if weeks:
            out.append(f"{r.name}: the previous interval's shifts entered for them already leave no 24 hours off in the "
                       f"7 days from {P.label(weeks[0])}" + (f" (and {len(weeks) - 1} later start{'s' if len(weeks) > 2 else ''})" if len(weeks) > 1 else "")
                       + ". That week cannot be fixed in this interval, so it is not held against this schedule.")
    return out
