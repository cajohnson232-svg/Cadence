"""Writes seed_demo.sql: a small made-up program that exercises every table.

    python seed_demo.py > seed_demo.sql
"""
import json
from datetime import date, timedelta

out = []


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, date):
        return f"'{v.isoformat()}'"
    if isinstance(v, list):
        return "ARRAY[" + ",".join(str(x) for x in v) + "]::integer[]"
    if isinstance(v, dict):
        return "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def ins(table, **cols):
    out.append(f'INSERT INTO "{table}" (' + ", ".join(f'"{c}"' for c in cols) + ") VALUES ("
               + ", ".join(lit(v) for v in cols.values()) + ");")


P = "prog_demo"
D = lambda m, d, y=2027: date(y, m, d)     # noqa: E731
ALL, NOT_WED, WED = [0, 1, 2, 3, 4, 5, 6], [0, 1, 3, 4, 5, 6], [2]

ins("Program", id=P, name="Demo EM Residency", shortCode="DEMO", timezone="America/Chicago")
for uid, email, name in [("u_admin", "coordinator@example.org", "Pat Coordinator"), ("u_chief", "nguyen@example.org", "Dr. Nguyen"),
                         ("u_res", "adams@example.org", "Dr. Adams")]:
    ins("User", id=uid, email=email, name=name)

for iid, name, code, addr in [("inst_mhh", "Memorial Hermann Hospital", "MHH", "6411 Fannin St, Houston, TX"),
                              ("inst_lbj", "LBJ Hospital", "LBJ", "5656 Kelley St, Houston, TX")]:
    ins("Institution", id=iid, programId=P, name=name, shortCode=code, timezone="America/Chicago", address=addr)
for aid, inst, name, code in [("area_t", "inst_mhh", "Trauma", "T"), ("area_m", "inst_mhh", "Medical", "M"),
                              ("area_gp", "inst_lbj", "General", "GP"), ("area_cc", "inst_lbj", "Critical care", "CC")]:
    ins("Area", id=aid, institutionId=inst, name=name, shortCode=code)

ROLES = {"role_pgy1": ("PGY-1", 1, 16, 18), "role_pgy2": ("PGY-2", 2, 15, 17), "role_pgy3": ("PGY-3", 3, 14, 16),
         "role_rot": ("Off-service rotator", 1, 7, 8)}
for rid, (name, level, lo, hi) in ROLES.items():
    ins("Role", id=rid, programId=P, name=name, level=level, defaultMinShifts=lo, defaultMaxShifts=hi)

for cid, name, order, night, group in [("cat_day", "Day", 0, False, None), ("cat_eve", "Evening", 1, False, "Evening"),
                                       ("cat_swing", "Swing", 2, False, "Evening"), ("cat_night", "Night", 3, True, None)]:
    ins("ShiftCategory", id=cid, programId=P, name=name, sortOrder=order, isNight=night, balanceGroup=group)

SHIFTS = [  # id, name, institution, area, category, start, minutes, days
    ("s_dt", "Day T", "inst_mhh", "area_t", "cat_day", 7 * 60, 480, NOT_WED),
    ("s_dtw", "Day T (after conference)", "inst_mhh", "area_t", "cat_day", 12 * 60, 480, WED),
    ("s_dm", "Day M", "inst_mhh", "area_m", "cat_day", 7 * 60, 480, NOT_WED),
    ("s_dmw", "Day M (after conference)", "inst_mhh", "area_m", "cat_day", 12 * 60, 480, WED),
    ("s_ft", "Fast track", "inst_mhh", "area_m", "cat_day", 10 * 60, 480, [0, 1, 3, 4]),
    ("s_et", "Evening T", "inst_mhh", "area_t", "cat_eve", 15 * 60, 480, ALL),
    ("s_em", "Evening M", "inst_mhh", "area_m", "cat_eve", 15 * 60, 480, ALL),
    ("s_nt", "Night T", "inst_mhh", "area_t", "cat_night", 23 * 60, 480, ALL),
    ("s_nm", "Night M", "inst_mhh", "area_m", "cat_night", 23 * 60, 480, ALL),
    ("s_dg", "Day GP", "inst_lbj", "area_gp", "cat_day", 7 * 60, 600, NOT_WED),
    ("s_dgw", "Day GP (after conference)", "inst_lbj", "area_gp", "cat_day", 12 * 60, 600, WED),
    ("s_sc", "Swing CC", "inst_lbj", "area_cc", "cat_swing", 14 * 60, 600, ALL),
    ("s_ng", "Night GP", "inst_lbj", "area_gp", "cat_night", 21 * 60, 600, ALL),
]
for sid, name, inst, area, cat, start, dur, days in SHIFTS:
    ins("Shift", id=sid, programId=P, institutionId=inst, areaId=area, categoryId=cat, name=name, startMinute=start,
        durationMinutes=dur, daysOfWeek=days)
    for rid in ROLES:      # trauma shifts need PGY-2+; one PGY-3 is required on the trauma night
        junior = ROLES[rid][1] == 1
        ins("ShiftRole", shiftId=sid, roleId=rid, eligible=not (junior and area == "area_t"),
            requiredCount=1 if (sid == "s_nt" and rid == "role_pgy3") else 0)

PEOPLE = [("p01", "Avery", "Adams", "role_pgy1"), ("p02", "Blake", "Brooks", "role_pgy1"), ("p03", "Casey", "Chen", "role_pgy1"),
          ("p04", "Devon", "Diaz", "role_pgy1"), ("p05", "Emery", "Evans", "role_pgy1"), ("p06", "Finley", "Flores", "role_pgy1"),
          ("p07", "Gray", "Garcia", "role_pgy2"), ("p08", "Harper", "Kim", "role_pgy2"), ("p09", "Indra", "Iyer", "role_pgy2"),
          ("p10", "Jordan", "Jones", "role_pgy2"), ("p11", "Kai", "Lee", "role_pgy2"), ("p12", "Logan", "Lopez", "role_pgy2"),
          ("p13", "Morgan", "Nguyen", "role_pgy3"), ("p14", "Noor", "Okafor", "role_pgy3"), ("p15", "Oakley", "Patel", "role_pgy3"),
          ("p16", "Parker", "Quinn", "role_pgy3"), ("p17", "Quincy", "Reyes", "role_pgy3"), ("p18", "Riley", "Stone", "role_rot")]
for pid, first, last, role in PEOPLE:
    ins("Participant", id=pid, programId=P, roleId=role, firstName=first, lastName=last, email=f"{last.lower()}@example.org",
        calendarToken=f"cal_{pid}")
ins("Membership", id="m1", programId=P, userId="u_admin", access="ADMIN")
ins("Membership", id="m2", programId=P, userId="u_chief", access="CHIEF", participantId="p13")
ins("Membership", id="m3", programId=P, userId="u_res", access="RESIDENT", participantId="p01")

ins("Interval", id="iv_6", programId=P, name="Block 6", startDate=D(12, 7, 2026), endDate=D(1, 3), status="PUBLISHED")
ins("Interval", id="iv_7", programId=P, name="Block 7", startDate=D(1, 4), endDate=D(1, 31), status="DRAFT",
    requestDeadline="2026-12-15 23:59:00", requestAllowance=4, highPriorityAllowance=1)

SITES = {"p04": ["inst_mhh"], "p05": ["inst_lbj"], "p09": ["inst_mhh"], "p10": ["inst_lbj"], "p17": ["inst_mhh"], "p18": ["inst_mhh"]}
for pid, _, _, role in PEOPLE:
    lo, hi = ROLES[role][2], ROLES[role][3]
    end = D(1, 17) if pid == "p18" else D(1, 31)          # the rotator is only here for two weeks
    ins("Assignment", id=f"as_{pid}", programId=P, participantId=pid, startDate=D(1, 4), endDate=end, minShifts=lo, maxShifts=hi)
    for inst in SITES.get(pid, ["inst_mhh", "inst_lbj"]):
        ins("AssignmentInstitution", assignmentId=f"as_{pid}", institutionId=inst)
for sid in ("s_dm", "s_dmw", "s_em", "s_ft"):               # the rotator only works these
    ins("AssignmentShift", assignmentId="as_p18", shiftId=sid)

# Special staffing: a holiday with 12-hour shifts at MHH, and a changed day at LBJ.
ins("SpecialStaffingDay", id="sp_mlk", programId=P, institutionId="inst_mhh", date=D(1, 18), name="MLK Day", mode="REPLACE")
for i, (base, name, start) in enumerate([("s_dt", "Holiday Day T", 7 * 60), ("s_dm", "Holiday Day M", 7 * 60),
                                         ("s_nt", "Holiday Night T", 19 * 60), ("s_nm", "Holiday Night M", 19 * 60)]):
    ins("SpecialStaffingShift", id=f"sps_mlk{i}", specialStaffingDayId="sp_mlk", action="ADD", shiftId=base, name=name,
        startMinute=start, durationMinutes=720)
ins("SpecialStaffingDay", id="sp_ev", programId=P, institutionId="inst_lbj", date=D(1, 29), name="Department retreat", mode="MODIFY")
ins("SpecialStaffingShift", id="sps_ev0", specialStaffingDayId="sp_ev", action="REMOVE", shiftId="s_sc")
ins("SpecialStaffingShift", id="sps_ev1", specialStaffingDayId="sp_ev", action="CHANGE", shiftId="s_dg", minParticipants=2, maxParticipants=2)

# Academic time: conference every Wednesday (time varies some weeks), and a PGY-1 session on two Fridays.
ins("AcademicDay", id="ac_conf", programId=P, name="Wednesday conference", dayOfWeek=2, startMinute=7 * 60, durationMinutes=300,
    overlapPolicy="BLOCKED")
ins("AcademicDayOccurrence", id="aco1", academicDayId="ac_conf", date=D(1, 13), startMinute=8 * 60, durationMinutes=180)
ins("AcademicDayOccurrence", id="aco2", academicDayId="ac_conf", date=D(1, 20), cancelled=True)
ins("AcademicDayOccurrence", id="aco3", academicDayId="ac_conf", date=D(1, 27), durationMinutes=240)
ins("AcademicDayException", id="ace1", academicDayId="ac_conf", participantId="p05", type="EXCUSED", startDate=D(1, 6),
    endDate=D(1, 6), reason="Away rotation interview")
ins("AcademicDay", id="ac_boot", programId=P, name="Intern skills lab", dayOfWeek=4, startMinute=13 * 60, durationMinutes=120,
    startDate=D(1, 4), endDate=D(1, 17), overlapPolicy="EXCUSED")
ins("AcademicDayRole", academicDayId="ac_boot", roleId="role_pgy1")

# Time off: vacation, requests (one pending, one denied, one mandatory), first / last day off presets.
T = [("to1", "p02", None, "VACATION", D(1, 11), D(1, 17), None, False, "APPROVED", None),
     ("to2", "p10", None, "VACATION", D(1, 23), D(1, 26), None, False, "APPROVED", None),
     ("to3", "p01", "iv_7", "REQUEST_OFF", D(1, 9), D(1, 10), "HIGH", False, "APPROVED", "Wedding"),
     ("to4", "p01", "iv_7", "REQUEST_OFF", D(1, 22), D(1, 22), "LOW", False, "APPROVED", None),
     ("to5", "p07", "iv_7", "REQUEST_OFF", D(1, 16), D(1, 16), "MEDIUM", False, "APPROVED", None),
     ("to6", "p14", "iv_7", "REQUEST_OFF", D(1, 30), D(1, 30), None, True, "APPROVED", "Board exam"),
     ("to7", "p03", "iv_7", "REQUEST_OFF", D(1, 12), D(1, 12), "MEDIUM", False, "PENDING", None),
     ("to8", "p09", "iv_7", "REQUEST_OFF", D(1, 5), D(1, 5), "LOW", False, "DENIED", None),
     ("to9", "p05", "iv_7", "FIRST_DAY_OFF", D(1, 4), D(1, 4), "HIGH", False, "APPROVED", "Coming off ICU nights"),
     ("to10", "p11", "iv_7", "LAST_DAY_OFF", D(1, 31), D(1, 31), "MEDIUM", False, "APPROVED", None)]
for tid, pid, iv, kind, a, b, prio, mand, status, reason in T:
    ins("TimeOff", id=tid, programId=P, participantId=pid, intervalId=iv, kind=kind, startDate=a, endDate=b, priority=prio,
        mandatory=mand, status=status, reason=reason, createdById="u_admin")
for i, (pid, delta, reason) in enumerate([("p13", -2, "Chief duties"), ("p08", 1, "Make-up shift"), ("p02", -4, "Vacation week"),
                                          ("p10", -2, "Vacation")]):
    ins("ShiftAdjustment", id=f"adj{i}", programId=P, participantId=pid, intervalId="iv_7", delta=delta, reason=reason,
        createdById="u_admin")

# Rules: the system set, then program-specific ones.
lib = json.load(open(__file__.rsplit("/", 1)[0] + "/rule-templates.json"))
for i, r in enumerate(lib["systemRules"]):
    ins("Rule", id=f"sys{i:02d}", programId=P, scope="PROGRAM", template=r["template"], params=r["params"], level=r["level"],
        weight=r.get("weight"), priority=r.get("priority"), source="SYSTEM", updatedAt="2026-11-14 00:00:00")
R = [dict(id="r_bal_mhh", scope="INSTITUTION", institutionId="inst_mhh", template="balance_areas", level="SOFT", weight=10, priority=6,
          params={"area_a": "area_t", "area_b": "area_m", "tolerance_shifts": 1}),
     dict(id="r_bal_lbj", scope="INSTITUTION", institutionId="inst_lbj", template="balance_areas", level="SOFT", weight=10, priority=6,
          params={"area_a": "area_gp", "area_b": "area_cc", "tolerance_shifts": 1}),
     dict(id="r_chief", scope="PARTICIPANT", participantId="p13", template="unavailable", level="HARD",
          params={"weekdays": [3], "start": "00:00", "hours": 13}, notes="Chief days"),
     dict(id="r_ai", scope="PARTICIPANT", participantId="p08", template="unavailable", level="HARD", source="AI_ASSISTED",
          params={"category_ids": ["cat_night"], "institution_ids": ["inst_lbj"]}, activeFrom=D(1, 10), activeTo=D(1, 24),
          originalText="Dr. Kim can't work overnights at LBJ from Jan 10 to Jan 24", notes="No LBJ overnights"),
     dict(id="r_cap", scope="ROLE", roleId="role_pgy1", template="max_shifts_per_interval", level="HARD", params={"n": 17}),
     dict(id="r_rest", scope="PROGRAM", template="min_hours_off_between_shifts", level="HARD", params={"hours": 10}),
     dict(id="r_pair", scope="PARTICIPANT", participantId="p03", template="work_with", level="SOFT", weight=5, priority=9,
          params={"participant_id": "p04", "together": False}),
     dict(id="r_wknd", scope="PROGRAM", template="weekends_per_interval", level="SOFT", weight=5, priority=9, params={"min": 1, "max": 3}),
     dict(id="r_custom", scope="PARTICIPANT", participantId="p11", template="custom", level="SOFT", weight=5, priority=9,
          params={"text": "Try to keep Dr. Lee off the Sunday before boards"}, needsReview=True, source="AI_ASSISTED",
          originalText="Try to keep Dr. Lee off the Sunday before boards"),
     dict(id="r_old", scope="PROGRAM", template="max_consecutive_shifts", level="HARD", params={"n": 5}, activeTo=D(12, 31, 2026)),
     dict(id="r_off", scope="PROGRAM", template="max_shifts_per_week", level="HARD", params={"n": 5}, enabled=False)]
for r in R:
    ins("Rule", programId=P, createdById="u_admin", updatedAt="2026-11-14 00:00:00", **r)

# Last block's published schedule: only its final week matters for the boundary rules.
ins("Schedule", id="sch_6", intervalId="iv_6", source="IMPORT", status="PUBLISHED", label="Imported from spreadsheet")
k = 0
def worked(pid, sid, first, last):          # noqa: E302
    global k
    name, inst, _, cat, start, dur = next((s[1], s[2], s[3], s[4], s[5], s[6]) for s in SHIFTS if s[0] == sid)
    d = first
    while d <= last:
        t0 = f"{d.isoformat()} {start // 60:02d}:{start % 60:02d}:00"
        end = d + timedelta(days=(start + dur) // 1440)
        t1 = f"{end.isoformat()} {(start + dur) % 1440 // 60:02d}:{(start + dur) % 60:02d}:00"
        ins("ScheduledShift", id=f"ss6_{k}", scheduleId="sch_6", participantId=pid, institutionId=inst, categoryId=cat,
            shiftId=sid, name=name, dutyDate=d, startsAt=t0, endsAt=t1)
        k += 1; d += timedelta(days=1)
worked("p07", "s_nm", D(1, 1), D(1, 3))            # ends the block on three nights
worked("p01", "s_dm", D(12, 31, 2026), D(1, 3))    # four straight days
worked("p15", "s_et", D(1, 2), D(1, 3))
print("\n".join(out))
