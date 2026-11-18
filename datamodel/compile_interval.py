"""LEGACY REFERENCE. The web app compiles intervals itself (web/src/lib/compile.ts); this Python version
is kept only for the data-model test and is no longer feature-complete (no backup shifts, site split
or personal academic days). Do not use it to drive the engine.

The bridge between the web app's database and the scheduling engine.

    compile_interval(db, interval_id) -> {"config": ..., "compiled_rules": [...], "warnings": [...]}

  * config          the engine's input for that interval (same format as tests/configs/*.json)
  * compiled_rules  ONE uniform list: every rule, vacation, request, preset, academic session and
                    contract that applies to the interval, each marked as enforced by the engine or
                    stored only. This is the data behind the "Compiled rules for this interval" view.
  * warnings        anything an admin should know before running (pending requests, pro-rated
                    contracts, settings the engine cannot honour yet).

    save_schedule(db, interval_id, problem, assignment, report)   writes the result back
    calendar_feed(db, participant_id)                              the personal .ics export

`db` is any callable that runs SQL and returns rows as dicts. This is a reference implementation
in Python; the production app can keep it as the engine's input adapter or port it.
"""
from __future__ import annotations
import json
import os
from datetime import date, datetime, timedelta

LIB = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rule-templates.json")))
TEMPLATES = {t["key"]: t for t in LIB["templates"]}
WEIGHT = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
ENGINE_GOAL_ORDER = ["forward_rotation", "balance_shift_categories", "min_days_between_night_runs", "no_night_before_time_off",
                     "max_night_fraction", "balance_areas", "consecutive_days_off", "single_night_run"]


def _d(v):
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def _hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _daterange(a, b):
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


def compile_interval(db, interval_id):
    warn, compiled = [], []
    iv = db(f"""SELECT * FROM "Interval" WHERE id = '{interval_id}'""")[0]
    pid = iv["programId"]
    start, end = _d(iv["startDate"]), _d(iv["endDate"])
    n = (end - start).days + 1
    idx = lambda d: (_d(d) - start).days                                       # noqa: E731
    inside = lambda d: start <= _d(d) <= end                                   # noqa: E731

    roles = {r["id"]: r for r in db(f"""SELECT * FROM "Role" WHERE "programId" = '{pid}'""")}
    cats = {c["id"]: c for c in db(f"""SELECT * FROM "ShiftCategory" WHERE "programId" = '{pid}' ORDER BY "sortOrder" """)}
    insts = {i["id"]: i for i in db(f"""SELECT * FROM "Institution" WHERE "programId" = '{pid}'""")}
    areas = {a["id"]: a for a in db("""SELECT * FROM "Area" """) if a["institutionId"] in insts}
    people = {p["id"]: p for p in db(f"""SELECT * FROM "Participant" WHERE "programId" = '{pid}' AND active AND "archivedAt" IS NULL""")}
    pname = lambda p: f"{people[p]['firstName']} {people[p]['lastName']}" if p in people else p   # noqa: E731

    # ---------------- rules in force during the interval ----------------
    rules = db(f"""SELECT * FROM "Rule" WHERE "programId" = '{pid}' AND enabled AND "archivedAt" IS NULL
                   AND ("activeFrom" IS NULL OR "activeFrom" <= '{end}') AND ("activeTo" IS NULL OR "activeTo" >= '{start}')
                   ORDER BY level, priority NULLS LAST, id""")
    try:
        import jsonschema
    except ImportError:
        jsonschema = None

    def target(r):
        return {"PROGRAM": "Whole program", "INSTITUTION": insts.get(r["institutionId"], {}).get("name"),
                "ROLE": roles.get(r["roleId"], {}).get("name"), "PARTICIPANT": pname(r["participantId"])}[r["scope"]]

    def names(p):                      # ids -> readable names for display
        look = {**{k: v["name"] for k, v in cats.items()}, **{k: v["name"] for k, v in insts.items()},
                **{k: v["name"] for k, v in areas.items()}, **{k: v["name"] for k, v in roles.items()},
                **{k: pname(k) for k in people}}
        out = {k: ([look.get(x, x) for x in v] if isinstance(v, list) else look.get(v, v) if isinstance(v, str) else v)
               for k, v in p.items()}
        if "together" in out:
            out["together"] = "Must" if out["together"] else "Must not"
        return out

    def unavailable_text(q):
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        parts = []
        if q.get("category_ids"):
            parts.append("/".join(cats[c]["name"] for c in q["category_ids"]) + " shifts")
        if q.get("institution_ids"):
            parts.append("at " + ", ".join(insts[i]["name"] for i in q["institution_ids"]))
        if q.get("weekdays") is not None:
            parts.append("on " + ", ".join(days[d] for d in q["weekdays"]))
        if q.get("start"):
            parts.append(f"from {q['start']} for {q['hours']:g}h")
        return "Cannot work " + (" ".join(parts) if parts else "at all")

    live = []
    for r in rules:
        t = TEMPLATES.get(r["template"])
        status, note = "stored only", None
        if t is None:
            status, note = "needs review", "unknown template"
        else:
            if jsonschema:
                try:
                    jsonschema.validate(r["params"], t["params"])
                except jsonschema.ValidationError as e:
                    warn.append(f"Rule {r['id']} ({t['label']}): parameters do not match the template: {e.message}")
                    status, note = "needs review", "invalid parameters"
            if status != "needs review":
                enforced = t["solver"] == "enforced" and r["scope"] in t.get("enforcedScopes", [])
                if r["template"] in ("unavailable", "min_hours_off_between_shifts") and r["level"] != "HARD":
                    enforced = False
                status = "enforced" if enforced else "stored only"
                note = t.get("solverNote") if not enforced else None
                if r["template"] == "custom" or r["needsReview"]:
                    status = "needs review"
        if status == "enforced":
            live.append(r)
        label = t["sentence"].format(**{**{k: "?" for k in ("hours", "ratio", "n", "days", "percent", "max_length",
                                     "tolerance_shifts", "area_a", "area_b", "min", "max", "together", "participant_id",
                                     "shift_id", "role_id", "count", "text")}, **names(r["params"])}) if t else r["template"]
        if r["template"] == "unavailable" and t:
            label = unavailable_text(r["params"])
        compiled.append({"origin": "Rule", "id": r["id"], "template": r["template"], "text": label, "scope": r["scope"],
                         "applies_to": target(r), "level": r["level"], "weight": r["weight"], "priority": r["priority"],
                         "from": r["activeFrom"], "to": r["activeTo"], "source": r["source"], "engine": status, "note": note})

    def one(template, key, default):
        got = [r for r in live if r["template"] == template and r["scope"] == "PROGRAM"]
        if not got:
            warn.append(f"No active program rule '{TEMPLATES[template]['label']}': the engine default ({default}) applies.")
            return default
        return got[0]["params"].get(key, default) if key else True

    cfg_rules = {"max_week_hours": one("max_hours_rolling_week", "hours", 60),
                 "rest_ratio": one("rest_equal_to_shift_length", "ratio", 1),
                 "max_nights": one("max_nights_per_interval", "n", 8),
                 "max_night_runs": one("max_night_runs", "n", 2),
                 "min_gap_between_night_runs": one("min_days_between_night_runs", "days", 7),
                 "max_night_fraction_pct": one("max_night_fraction", "percent", 45),
                 "soft_max_nights_in_run": one("single_night_run", "max_length", 6),
                 "balance_tolerance_shifts": one("balance_shift_categories", "tolerance_shifts", 1)}
    rest = [r["params"]["hours"] for r in live if r["template"] == "min_hours_off_between_shifts"]
    if rest:
        cfg_rules["min_rest_hours"] = max(rest)
    for always in ("one_day_off_in_seven", "forward_rotation", "consecutive_days_off", "no_night_before_time_off"):
        if not any(r["template"] == always for r in live):
            warn.append(f"'{TEMPLATES[always]['label']}' is not active, but the engine always applies it.")
    pairs = [r for r in live if r["template"] == "balance_areas"]
    pod_pairs = [[insts[areas[r["params"]["area_a"]]["institutionId"]]["shortCode"], areas[r["params"]["area_a"]]["shortCode"],
                  areas[r["params"]["area_b"]]["shortCode"]] for r in pairs]
    if pairs:
        cfg_rules["pod_tolerance_shifts"] = min(r["params"]["tolerance_shifts"] for r in pairs)
    order = [r["template"] for r in sorted((r for r in live if r["level"] == "SOFT" and r["priority"]), key=lambda r: r["priority"])]
    seen = [t for t in dict.fromkeys(order) if t in ENGINE_GOAL_ORDER]
    if seen != [t for t in ENGINE_GOAL_ORDER if t in seen]:
        warn.append("Soft-rule priorities differ from the engine's built-in order; the engine's order is used for now.")

    # ---------------- shift templates, with special staffing days folded in ----------------
    shifts = {s["id"]: s for s in db(f"""SELECT * FROM "Shift" WHERE "programId" = '{pid}' AND active AND "archivedAt" IS NULL AND NOT "isBackup" """)}
    elig = {(e["shiftId"], e["roleId"]): e for e in db("""SELECT * FROM "ShiftRole" """) if e["shiftId"] in shifts}
    levels = sorted({r["level"] for r in roles.values()})

    def min_level(sid):
        ok = {roles[rid]["level"] for rid in roles if elig.get((sid, rid), {"eligible": True})["eligible"]}
        bad = {roles[rid]["level"] for rid in roles if not elig.get((sid, rid), {"eligible": True})["eligible"]}
        lo = min(ok) if ok else max(levels) + 1
        return lo, not any(b >= lo for b in bad)            # (minimum level, eligibility is simply "this level and up")

    def template(s, **over):
        g = {**s, **{k: v for k, v in over.items() if v is not None}}
        lo, _ = min_level(s["id"]) if s.get("id") in shifts else (1, True)
        return {"name": g["name"], "ref": s.get("id") or g["name"], "site": insts[g["institutionId"]]["shortCode"],
                "pod": areas[g["areaId"]]["shortCode"] if g.get("areaId") else "", "category": cats[g["categoryId"]]["name"],
                "start": _hhmm(g["startMinute"]), "hours": g["durationMinutes"] / 60, "headcount": g["minParticipants"],
                "max_headcount": max(g.get("maxParticipants") or 0, g["minParticipants"]),
                "min_pgy": lo, "counts_as_previous_day": bool(g.get("countsAsPreviousDay")),
                "weekdays": list(g.get("daysOfWeek") or []), "except_days": []}

    tmpl = {sid: template(s) for sid, s in shifts.items()}
    for sid, s in shifts.items():
        need = sum(e["requiredCount"] for (a, _), e in elig.items() if a == sid)
        if need:
            warn.append(f"{s['name']}: per-role headcounts are stored but the engine staffs to the total only.")
        if s["maxParticipants"] > s["minParticipants"]:
            warn.append(f"{s['name']}: the engine staffs to the minimum headcount ({s['minParticipants']}).")
    dated = []
    for sd in db(f"""SELECT * FROM "SpecialStaffingDay" WHERE "programId" = '{pid}' AND date BETWEEN '{start}' AND '{end}'"""):
        d, wd = idx(sd["date"]), _d(sd["date"]).weekday()
        lines = db(f"""SELECT * FROM "SpecialStaffingShift" WHERE "specialStaffingDayId" = '{sd["id"]}' ORDER BY id""")
        if sd["mode"] == "REPLACE":
            for sid, s in shifts.items():
                if s["institutionId"] == sd["institutionId"] and wd in s["daysOfWeek"]:
                    tmpl[sid]["except_days"].append(d)
        for ln in lines:
            base = shifts.get(ln["shiftId"])
            if ln["action"] in ("CHANGE", "REMOVE") and sd["mode"] == "MODIFY":
                tmpl[ln["shiftId"]]["except_days"].append(d)
            if ln["action"] == "REMOVE":
                continue
            src = dict(base) if base else {"institutionId": sd["institutionId"], "minParticipants": 1}
            src["institutionId"] = sd["institutionId"]
            over = {k: ln[k] for k in ("categoryId", "areaId", "startMinute", "durationMinutes", "countsAsPreviousDay",
                                       "minParticipants", "maxParticipants")}
            over["name"] = ln["name"] or f"{base['name']} ({sd['name']})"
            t = template(src, **over)
            t.pop("weekdays"); t.pop("except_days")
            t["only_days"], t["special_ref"] = [d], ln["id"]
            dated.append(t)
        compiled.append({"origin": "Special staffing day", "id": sd["id"], "template": "special_staffing", "scope": "INSTITUTION",
                         "applies_to": insts[sd["institutionId"]]["name"], "level": "HARD", "from": sd["date"], "to": sd["date"],
                         "text": f"{sd['name']}: {'only the listed shifts run' if sd['mode'] == 'REPLACE' else 'normal shifts with changes'} "
                                 f"({len(lines)} line(s))", "engine": "enforced"})
    templates = list(tmpl.values()) + dated

    # ---------------- participants: who is here, for how many shifts, and when they are off ----------------
    asg = db(f"""SELECT * FROM "Assignment" WHERE "programId" = '{pid}' AND "startDate" <= '{end}' AND "endDate" >= '{start}'""")
    a_inst, a_shift, a_win = {}, {}, {}
    for r in db("""SELECT * FROM "AssignmentInstitution" """):
        a_inst.setdefault(r["assignmentId"], []).append(r["institutionId"])
        if r.get("startDate") or r.get("endDate"):
            a_win.setdefault(r["assignmentId"], []).append(r)
    for r in db("""SELECT * FROM "AssignmentShift" """):
        a_shift.setdefault(r["assignmentId"], []).append(r["shiftId"])
    adj = db(f"""SELECT * FROM "ShiftAdjustment" WHERE "intervalId" = '{interval_id}'""")
    off = db(f"""SELECT * FROM "TimeOff" WHERE "programId" = '{pid}' AND "startDate" <= '{end}' AND "endDate" >= '{start}'
                 ORDER BY "startDate", id""")
    pending = [t for t in off if t["status"] == "PENDING"]
    if pending:
        warn.append(f"{len(pending)} time-off request(s) are still pending and are NOT included.")
    cat_by_name = {c["name"] for c in cats.values()}
    residents = []
    for p in sorted(people.values(), key=lambda p: (p["lastName"], p["firstName"])):
        mine = [a for a in asg if a["participantId"] == p["id"]]
        if not mine:
            continue
        here, lo, hi, sites, only = set(), 0, 0, set(), set()
        for a in mine:
            a0, a1 = _d(a["startDate"]), _d(a["endDate"])
            days = [d for d in _daterange(a0, a1) if inside(d)]
            here |= {idx(d) for d in days}
            share = len(days) / ((a1 - a0).days + 1)
            if share < 1:
                warn.append(f"{pname(p['id'])}: assignment {a0} to {a1} only partly overlaps the interval; "
                            f"its shift count is pro-rated to {share:.0%}.")
            r_min = a["minShifts"] if a["minShifts"] is not None else roles[p["roleId"]]["defaultMinShifts"]     # empty = the role's default
            r_max = a["maxShifts"] if a["maxShifts"] is not None else roles[p["roleId"]]["defaultMaxShifts"]
            lo += round(r_min * share); hi += round(r_max * share)
            sites |= set(a_inst.get(a["id"], insts))
            only |= set(a_shift.get(a["id"], []))
        delta = sum(x["delta"] for x in adj if x["participantId"] == p["id"])
        caps = [r["params"]["n"] for r in live if r["template"] == "max_shifts_per_interval" and (
            r["scope"] == "PROGRAM" or r["roleId"] == p["roleId"] or r["participantId"] == p["id"])]
        hi = max(0, min([hi + delta] + caps)); lo = max(0, min(lo + delta, hi))
        level = roles[p["roleId"]]["level"]
        role_ok = {sid for sid in shifts if elig.get((sid, p["roleId"]), {"eligible": True})["eligible"]}
        allowed = (role_ok & only) if only else role_ok
        simple = {sid for sid in shifts if level >= tmpl[sid]["min_pgy"]}
        res = {"id": p["id"], "name": pname(p["id"]), "pgy": level, "shifts_min": lo, "shifts_max": hi,
               "sites": sorted(insts[i]["shortCode"] for i in sites), "vacation": [], "mandatory_off": sorted(set(range(n)) - here),
               "requests_off": {}, "unavailable": []}
        # (17 Nov 2026) the two assignment settings the original tests rely on; the web app's compile step covers the rest
        for a in mine:
            if a.get("noNights"):
                res["unavailable"].append({"label": "no nights", "categories": sorted(c["name"] for c in cats.values() if c["isNight"])})
            for w in a_win.get(a["id"], []):
                code = insts[w["institutionId"]]["shortCode"]
                if w.get("startDate"):
                    res["unavailable"].append({"label": f"not at {code} yet", "sites": [code], "to_day": idx(_d(w["startDate"])) - 1})
                if w.get("endDate"):
                    res["unavailable"].append({"label": f"no longer at {code}", "sites": [code], "from_day": idx(_d(w["endDate"])) + 1})
        if allowed != simple:
            res["only_shifts"] = sorted(allowed)
        compiled.append({"origin": "Assignment", "id": mine[0]["id"], "template": "shift_count", "scope": "PARTICIPANT",
                         "applies_to": res["name"], "level": "HARD", "engine": "enforced",
                         "text": f"{lo}-{hi} shifts at {', '.join(res['sites'])}"
                                 + (f" (adjusted {delta:+d}: " + "; ".join(x["reason"] for x in adj if x["participantId"] == p["id"]) + ")" if delta else "")
                                 + (f"; present {len(here)} of {n} days" if len(here) < n else "")
                                 + ("; limited to listed shifts" if only else "")})
        for t in [t for t in off if t["participantId"] == p["id"]]:
            days = [idx(d) for d in _daterange(_d(t["startDate"]), _d(t["endDate"])) if inside(d)]
            kind = {"VACATION": "Vacation", "REQUEST_OFF": "Request off", "FIRST_DAY_OFF": "First day off",
                    "LAST_DAY_OFF": "Last day off", "REQUIRED_OFF": "Required time off"}[t["kind"]]
            entry = {"origin": kind, "id": t["id"], "template": "unavailable", "scope": "PARTICIPANT", "applies_to": res["name"],
                     "from": t["startDate"], "to": t["endDate"], "text": f"Off {t['startDate']} to {t['endDate']}"
                     + (f" ({t['reason']})" if t["reason"] else "")}
            if t["status"] != "APPROVED":
                compiled.append({**entry, "level": "-", "engine": f"not included ({t['status'].lower()})"})
                continue
            if t["kind"] == "REQUIRED_OFF" and t.get("startMinute") is not None and days:
                res["unavailable"].append({"from_day": min(days), "to_day": max(days), "start": f"{t['startMinute'] // 60:02d}:{t['startMinute'] % 60:02d}",
                                           "hours": (t["endMinute"] - t["startMinute"]) / 60, "label": "Required time off"})
                compiled.append({**entry, "level": "HARD", "engine": "enforced"})
            elif t["kind"] == "VACATION":
                res["vacation"] += days
                compiled.append({**entry, "level": "HARD", "engine": "enforced"})
            elif t["mandatory"]:
                res["mandatory_off"] = sorted(set(res["mandatory_off"]) | set(days))
                compiled.append({**entry, "level": "HARD", "engine": "enforced"})
            else:
                w = WEIGHT[t["priority"]]
                for d in days:
                    res["requests_off"][str(d)] = max(w, res["requests_off"].get(str(d), 0))
                compiled.append({**entry, "level": "SOFT", "weight": w, "priority": LIB["builtInPriorities"]["requests_off"],
                                 "engine": "enforced"})
        for r in live:
            if r["template"] == "unavailable" and (r["scope"] == "PROGRAM" or r["roleId"] == p["roleId"]
                                                   or r["participantId"] == p["id"]):
                q = r["params"]
                u = {"label": r["notes"] or "unavailable (rule)"}
                if r["activeFrom"]:
                    u["from_day"] = idx(r["activeFrom"])
                if r["activeTo"]:
                    u["to_day"] = idx(r["activeTo"])
                if q.get("weekdays") is not None:
                    u["weekdays"] = q["weekdays"]
                if q.get("start"):
                    u["start"], u["hours"] = q["start"], q["hours"]
                if q.get("category_ids"):
                    u["categories"] = [cats[c]["name"] for c in q["category_ids"]]
                if q.get("institution_ids"):
                    u["sites"] = [insts[i]["shortCode"] for i in q["institution_ids"]]
                res["unavailable"].append(u)
        res["vacation"] = sorted(set(res["vacation"]))
        residents.append(res)
    assert cat_by_name

    # ---------------- academic time: the recurring series expanded to dated sessions ----------------
    academic = []
    for ac in db(f"""SELECT * FROM "AcademicDay" WHERE "programId" = '{pid}' AND active AND "archivedAt" IS NULL ORDER BY id"""):
        occ = {str(_d(o["date"])): o for o in db(f"""SELECT * FROM "AcademicDayOccurrence" WHERE "academicDayId" = '{ac["id"]}'""")}
        exc = db(f"""SELECT * FROM "AcademicDayException" WHERE "academicDayId" = '{ac["id"]}'""")
        who = [r["roleId"] for r in db(f"""SELECT * FROM "AcademicDayRole" WHERE "academicDayId" = '{ac["id"]}'""")]
        count = 0
        for d in _daterange(start - timedelta(days=7), end):
            if d.weekday() != ac["dayOfWeek"] or (ac["startDate"] and d < _d(ac["startDate"])) or (ac["endDate"] and d > _d(ac["endDate"])):
                continue
            o = occ.get(str(d), {})
            if o.get("cancelled"):
                continue
            covers = lambda e: (not e["startDate"] or _d(e["startDate"]) <= d) and (not e["endDate"] or d <= _d(e["endDate"]))   # noqa: E731
            s = {"name": ac["name"], "day": idx(d), "start": _hhmm(o.get("startMinute") or ac["startMinute"]),
                 "hours": (o.get("durationMinutes") or ac["durationMinutes"]) / 60,
                 "if_shift_overlaps": (o.get("overlapPolicy") or ac["overlapPolicy"]).lower(),
                 "protect_before_hours": ac["protectBeforeMinutes"] / 60, "protect_after_hours": ac["protectAfterMinutes"] / 60,
                 "excused": [e["participantId"] for e in exc if e["type"] == "EXCUSED" and covers(e)],
                 "also_attend": [e["participantId"] for e in exc if e["type"] == "REQUIRED" and covers(e)]}
            if who:
                s["pgy"] = sorted({roles[r]["level"] for r in who})
            academic.append(s)
            count += d >= start
        compiled.append({"origin": "Academic day", "id": ac["id"], "template": "academic_time", "scope": "ROLE" if who else "PROGRAM",
                         "applies_to": ", ".join(roles[r]["name"] for r in who) or "Everyone", "level": "HARD", "engine": "enforced",
                         "text": f"{ac['name']}: {count} session(s) in the interval; overlapping shifts are {ac['overlapPolicy'].lower()}"
                                 + (f"; {len(exc)} personal exception(s)" if exc else "")})

    # ---------------- boundary: the last week of the previous published schedule ----------------
    history = []
    prev = db(f"""SELECT s.id FROM "Schedule" s JOIN "Interval" i ON i.id = s."intervalId"
                  WHERE i."programId" = '{pid}' AND s.status = 'PUBLISHED' AND i."endDate" < '{start}'
                  ORDER BY i."endDate" DESC LIMIT 1""")
    if prev:
        for h in db(f"""SELECT * FROM "ScheduledShift" WHERE "scheduleId" = '{prev[0]["id"]}' AND "participantId" IS NOT NULL AND NOT "backup"
                        AND "dutyDate" >= '{start - timedelta(days=7)}' ORDER BY "startsAt" """):
            if h["participantId"] not in {r["id"] for r in residents}:
                continue
            t0, t1 = datetime.fromisoformat(h["startsAt"]), datetime.fromisoformat(h["endsAt"])
            history.append({"resident": h["participantId"], "day": idx(t0.date()), "start": t0.strftime("%H:%M"),
                            "hours": (t1 - t0).total_seconds() / 3600, "category": cats[h["categoryId"]]["name"], "name": h["name"],
                            "counts_as_previous_day": _d(h["dutyDate"]) < t0.date()})
    else:
        warn.append("No published schedule for the previous interval: boundary rules start from a clean slate.")

    config = {"name": f"{iv['name']} ({start} to {end})", "start_date": str(start), "n_days": n,
              "category_order": [c["name"] for c in cats.values()],
              "night_categories": [c["name"] for c in cats.values() if c["isNight"]],
              "balance_groups": {c["name"]: c["balanceGroup"] or c["name"] for c in cats.values()},
              "pod_pairs": pod_pairs, "rules": cfg_rules, "shift_templates": templates, "academic_time": academic,
              "residents": residents, "history": history}
    return {"config": config, "compiled_rules": compiled, "warnings": warn}


def save_schedule(db, interval_id, P, assignment, report, schedule_id, source="SOLVER"):
    """Write an engine result back as a Schedule with one ScheduledShift per person per shift (open shifts included)."""
    iv = db(f"""SELECT * FROM "Interval" WHERE id = '{interval_id}'""")[0]
    start = _d(iv["startDate"])
    insts = {i["shortCode"]: i["id"] for i in db(f"""SELECT * FROM "Institution" WHERE "programId" = '{iv["programId"]}'""")}
    cats = {c["name"]: c["id"] for c in db(f"""SELECT * FROM "ShiftCategory" WHERE "programId" = '{iv["programId"]}'""")}
    shift_ids = {s["id"] for s in db("""SELECT id FROM "Shift" """)}
    who = {}
    for rid, keys in assignment.items():
        for k in keys:
            who.setdefault(k, []).append(rid)
    esc = lambda s: str(s).replace("'", "''")                                  # noqa: E731
    stamp = lambda m: (datetime.combine(start, datetime.min.time()) + timedelta(minutes=m)).isoformat(sep=" ")   # noqa: E731
    sql = [f"""INSERT INTO "Schedule" (id, "intervalId", source, status, report) VALUES
               ('{schedule_id}', '{interval_id}', '{source}', 'DRAFT', '{esc(json.dumps(report))}'::jsonb);"""]
    for s in P.slot_list:
        t = P.templates[s.key[1]]
        people = who.get(s.key, []) + [None] * (s.need - len(who.get(s.key, [])))
        for j, rid in enumerate(people):
            sql.append(f"""INSERT INTO "ScheduledShift" (id, "scheduleId", "participantId", "institutionId", "categoryId", "shiftId",
                           "specialStaffingShiftId", name, "dutyDate", "startsAt", "endsAt") VALUES
                           ('{schedule_id}_{s.key[0]}_{s.key[1]}_{j}', '{schedule_id}', {f"'{rid}'" if rid else 'NULL'}, '{insts[s.site]}',
                            '{cats[s.cat]}', {f"'{s.ref}'" if s.ref in shift_ids else 'NULL'},
                            {f"'{t['special_ref']}'" if t.get('special_ref') else 'NULL'}, '{esc(s.name)}',
                            '{start + timedelta(days=s.day)}', '{stamp(s.start)}', '{stamp(s.end)}');""")
    db("\n".join(sql), fetch=False)
    return len(sql) - 1


def calendar_feed(db, participant_id):
    """iCalendar text for one participant: their published shifts. Subscribable from Google, Apple, Outlook."""
    rows = db(f"""SELECT ss.*, i.name AS institution, i.timezone FROM "ScheduledShift" ss
                  JOIN "Schedule" s ON s.id = ss."scheduleId" JOIN "Institution" i ON i.id = ss."institutionId"
                  WHERE s.status = 'PUBLISHED' AND ss."participantId" = '{participant_id}' ORDER BY ss."startsAt" """)
    fmt = lambda t: datetime.fromisoformat(t).strftime("%Y%m%dT%H%M%S")        # noqa: E731
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cadence//Schedule//EN", "CALSCALE:GREGORIAN"]
    for r in rows:
        out += ["BEGIN:VEVENT", f"UID:{r['id']}@cadence", f"DTSTAMP:{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}",
                f"DTSTART;TZID={r['timezone']}:{fmt(r['startsAt'])}", f"DTEND;TZID={r['timezone']}:{fmt(r['endsAt'])}",
                f"SUMMARY:{r['name']}", f"LOCATION:{r['institution']}", "END:VEVENT"]
    return "\r\n".join(out + ["END:VCALENDAR"]) + "\r\n", len(rows)
