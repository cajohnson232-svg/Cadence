"""End-to-end test of the data model against a real PostgreSQL server.

    PGHOST=/tmp/pg PGPORT=5433 PGUSER=postgres python test_datamodel.py

1. build the tables from schema.prisma, add constraints.sql, load the demo program
2. confirm the database refuses bad data
3. compile "Block 7" into the engine's input, plus the uniform compiled-rules list
4. schedule it with the engine and check it with the independent validator
5. write the schedule back, publish it, export one person's calendar, and confirm the
   next block picks up its boundary history from it
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
from tools.prisma_check import parse, check, to_sql          # noqa: E402
import compile_interval as ci                                # noqa: E402
from cadence.problem import Problem                          # noqa: E402
from cadence import solver, validator                        # noqa: E402

DB = "cadence_test"
OUT = os.path.join(HERE, "demo_output"); os.makedirs(OUT, exist_ok=True)


def psql(sql, database=DB, check_=True):
    r = subprocess.run(["psql", "-d", database, "-At", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], input=sql, text=True, capture_output=True)
    if check_ and r.returncode:
        raise RuntimeError(r.stderr[-600:])
    return r


def db(sql, fetch=True):
    if not fetch:
        return psql(sql)
    return json.loads(psql(f"SELECT coalesce(json_agg(row_), '[]'::json) FROM ({sql}) row_").stdout)


print("== 1. Build the database ==")
enums, models = parse(open(f"{HERE}/schema.prisma").read())
errs = check(enums, models)
assert not errs, errs
psql(f"DROP DATABASE IF EXISTS {DB};", "postgres"); psql(f"CREATE DATABASE {DB};", "postgres")
psql(to_sql(enums, models)); psql(open(f"{HERE}/constraints.sql").read())
seed = subprocess.run([sys.executable, f"{HERE}/seed_demo.py"], capture_output=True, text=True, check=True).stdout
open(f"{HERE}/seed_demo.sql", "w").write(seed)
psql(seed)
tables = {m: db(f'SELECT count(*) AS n FROM "{m}"')[0]["n"] for m in models}
print(f"{len(models)} tables created; rows loaded:", ", ".join(f"{t} {n}" for t, n in tables.items() if n))
empty = [t for t, n in tables.items() if not n and t not in ("AuditLog",)]
print("tables with no demo rows:", empty or "none (besides AuditLog)")

print("\n== 2. The database refuses bad data ==")
BAD = {
    "overlapping assignments for one participant":
        """INSERT INTO "Assignment" (id, "programId", "participantId", "startDate", "endDate", "minShifts", "maxShifts")
           VALUES ('x', 'prog_demo', 'p01', '2027-01-20', '2027-02-10', 5, 6)""",
    "overlapping intervals":
        """INSERT INTO "Interval" (id, "programId", name, "startDate", "endDate") VALUES ('x', 'prog_demo', 'Overlap', '2027-01-25', '2027-02-20')""",
    "interval ending before it starts":
        """INSERT INTO "Interval" (id, "programId", name, "startDate", "endDate") VALUES ('x', 'prog_demo', 'Backwards', '2027-03-10', '2027-03-01')""",
    "deleting a role that people still have": """DELETE FROM "Role" WHERE id = 'role_pgy1'""",
    "deleting a shift that is on a published schedule": """DELETE FROM "Shift" WHERE id = 's_nm'""",
    "participant-scoped rule with no participant":
        """INSERT INTO "Rule" (id, "programId", scope, template, params, level) VALUES ('x', 'prog_demo', 'PARTICIPANT', 'unavailable', '{}', 'HARD')""",
    "soft rule with weight 11":
        """INSERT INTO "Rule" (id, "programId", scope, template, params, level, weight) VALUES ('x', 'prog_demo', 'PROGRAM', 'forward_rotation', '{}', 'SOFT', 11)""",
    "request off with no priority":
        """INSERT INTO "TimeOff" (id, "programId", "participantId", "intervalId", kind, "startDate", "endDate")
           VALUES ('x', 'prog_demo', 'p01', 'iv_7', 'REQUEST_OFF', '2027-01-05', '2027-01-05')""",
    "shift longer than 24 hours":
        """UPDATE "Shift" SET "durationMinutes" = 1500 WHERE id = 's_dt'""",
    "max headcount below min": """UPDATE "Shift" SET "minParticipants" = 3 WHERE id = 's_dt'""",
    "two participants with the same email":
        """INSERT INTO "Participant" (id, "programId", "roleId", "firstName", "lastName", email) VALUES ('x', 'prog_demo', 'role_pgy1', 'A', 'B', 'adams@example.org')""",
    "second published schedule for one interval":
        """INSERT INTO "Schedule" (id, "intervalId", source, status) VALUES ('x', 'iv_6', 'MANUAL', 'PUBLISHED')""",
    "special-day change with no shift named":
        """INSERT INTO "SpecialStaffingShift" (id, "specialStaffingDayId", action) VALUES ('x', 'sp_ev', 'CHANGE')""",
}
for what, sql in BAD.items():
    r = psql(sql, check_=False)
    assert r.returncode != 0, f"NOT refused: {what}"
    print(f"refused: {what}")

print("\n== 3. Compile Block 7 ==")
lib = ci.LIB
import jsonschema                                            # noqa: E402
for t in lib["templates"]:
    jsonschema.Draft202012Validator.check_schema(t["params"])
for r in lib["systemRules"]:
    jsonschema.validate(r["params"], ci.TEMPLATES[r["template"]]["params"])
print(f"rule library: {len(lib['templates'])} templates, all parameter schemas valid; "
      f"{sum(t['solver'] == 'enforced' for t in lib['templates'])} enforced by the engine today")
res = ci.compile_interval(db, "iv_7")
cfg, rules, warns = res["config"], res["compiled_rules"], res["warnings"]
json.dump(cfg, open(f"{OUT}/block7_engine_input.json", "w"), indent=1, default=str)
json.dump(rules, open(f"{OUT}/block7_compiled_rules.json", "w"), indent=1, default=str)
by = {}
for r in rules:
    by.setdefault((r["origin"], r["engine"]), []).append(r)
print(f"compiled rules: {len(rules)} entries")
for (origin, engine), rs in sorted(by.items()):
    print(f"  {origin:<22} {engine:<28} {len(rs)}")
print("warnings for the admin:")
for w in warns:
    print("  -", w)
with open(f"{OUT}/block7_compiled_rules.txt", "w") as f:
    for r in rules:
        f.write(f"{r['origin']:<21} {r.get('level', ''):<5} {r['engine']:<24} {str(r.get('applies_to')):<26} {r['text']}\n")

print("\n== 4. Schedule it ==")
P = Problem(cfg)
per = [sum(s.need for s in P.slot_list if s.day == d) for d in range(P.n_days)]
total = sum(per)
print(f"{len(P.residents)} participants, {total} shifts ({min(per)}-{max(per)} per day), "
      f"{len(P.academic)} academic sessions, {sum(len(h) for h in P.hist.values())} prior-block shifts carried in")
e, w = solver.precheck(P)
print("pre-check:", "feasible" if not e else e, "| warnings:", w or "none")
S = solver.Scheduler(P, log=lambda m: print("  " + m), seed=3)
out = S.run(seconds=float(os.environ.get("SECONDS_EXACT", 60)), polish_seconds=20)
A = out["assignment"]
V, opens, short = validator.validate(P, A)
soft = validator.soft_metrics(P, A)
print(f"validator: {len(V)} hard-rule violations, {sum(n for _, n in opens)} open shifts, {len(short)} under contract minimum; "
      f"moves rejected by validator: {out['stats'].get('rejected by validator', 0)}")
for v in V[:8]:
    print("   VIOLATION:", v)
print("soft goals:", {k: (round(v / S.scale[k], 1)) for k, v in soft.items()})
assert not V

# spot-checks that the database inputs really reached the schedule
shifts_of = lambda pid: [P.slots[k] for k in A[pid]]                     # noqa: E731
wd = lambda s: P.weekday(s.cal)                                          # noqa: E731
chk = {
    "chief (Nguyen) has nothing overlapping Thu 00:00-13:00": not any(
        s.start < d * 1440 + 780 and d * 1440 < s.end for s in shifts_of("p13") for d in range(-1, 29) if P.weekday(d) == 3),
    "Kim has no LBJ night between Jan 10 and Jan 24": not any(s.site == "LBJ" and s.cat == "Night" and 6 <= s.cal <= 20 for s in shifts_of("p08")),
    "Brooks is off for the whole vacation week": not any(7 <= s.cal <= 13 for s in shifts_of("p02")),
    "Okafor's mandatory day off (Jan 30) is free": not any(s.cal == 26 for s in shifts_of("p14")),
    "the rotator (Stone) only works Jan 4-17 and only the listed shifts": all(
        s.cal <= 13 and s.ref in ("s_dm", "s_dmw", "s_em", "s_ft") for s in shifts_of("p18")),
    "PGY-1s never work a trauma shift": not any(s.pod == "T" for r in P.residents if r.pgy == 1 and r.id != "p18" for s in shifts_of(r.id)),
    "nobody works across Wednesday conference": not any(
        s.start < a.end and a.start < s.end for a in P.academic if a.policy == "blocked" and a.day >= 0
        for r in P.residents if P.attends(r, a) for s in shifts_of(r.id)),
    "MLK Day at MHH runs only the four 12-hour holiday shifts": sorted(s.name for s in P.slot_list if s.day == 14 and s.site == "MHH") == [
        "Holiday Day M", "Holiday Day T", "Holiday Night M", "Holiday Night T"],
    "Jan 29 at LBJ: no swing shift, two on Day GP": [(s.name, s.need) for s in P.slot_list if s.day == 25 and s.site == "LBJ"] == [
        ("Day GP (Department retreat)", 2), ("Night GP", 1)],
    "PGY-1 contract capped at 17 by the role rule": all(len(A[r.id]) <= 17 for r in P.residents if r.pgy == 1),
    "Nguyen's contract is 12-14 after the -2 chief adjustment": (P.by_id["p13"].shifts_min, P.by_id["p13"].shifts_max) == (12, 14),
    "at least 10h off between any two shifts (program rule)": all(
        b.start - a.end >= 600 for r in P.residents for a, b in zip(sorted(shifts_of(r.id), key=lambda s: s.start),
                                                                    sorted(shifts_of(r.id), key=lambda s: s.start)[1:])),
    "Garcia (three nights to end Block 6) does not start Block 7 before 15:00 on Jan 4": all(s.start >= 15 * 60 for s in shifts_of("p07")),
    "Jan 20 conference was cancelled; Jan 13 runs 08:00-11:00": sorted((a.day, a.start % 1440, a.end % 1440) for a in P.academic
                                                                         if a.name == "Wednesday conference" and a.day >= 0)
        == [(2, 420, 720), (9, 480, 660), (23, 420, 660)],
}
for what, ok in chk.items():
    print(("ok:   " if ok else "FAIL: ") + what)
assert all(chk.values())

print("\n== 5. Write back, publish, export, next block ==")
nrows = ci.save_schedule(db, "iv_7", P, A, {"violations": len(V), "open": sum(n for _, n in opens), "soft": soft}, "sch_7")
db("""UPDATE "Schedule" SET status = 'PUBLISHED', "publishedAt" = now() WHERE id = 'sch_7';
      UPDATE "Interval" SET status = 'PUBLISHED', "publishedAt" = now() WHERE id = 'iv_7';""", fetch=False)
print(f"saved {nrows} scheduled shifts; open rows:", db("""SELECT count(*) AS n FROM "ScheduledShift" WHERE "scheduleId" = 'sch_7' AND "participantId" IS NULL""")[0]["n"])
ics, n_ev = ci.calendar_feed(db, "p01")
open(f"{OUT}/adams_calendar.ics", "w").write(ics)
print(f"calendar feed for Adams: {n_ev} events (Block 6 history + Block 7)")
db("""INSERT INTO "Interval" (id, "programId", name, "startDate", "endDate") VALUES ('iv_8', 'prog_demo', 'Block 8', '2027-02-01', '2027-02-28');
      INSERT INTO "Assignment" (id, "programId", "participantId", "startDate", "endDate", "minShifts", "maxShifts")
        SELECT 'as8_' || id, 'prog_demo', id, '2027-02-01', '2027-02-28', 14, 16 FROM "Participant" WHERE id <> 'p18';""", fetch=False)
nxt = ci.compile_interval(db, "iv_8")
P8 = Problem(nxt["config"])
carried = sum(len(h) for h in P8.hist.values())
last_week = sum(1 for keys in A.values() for k in keys if P.slots[k].day >= 21)
print(f"Block 8 compiles with {carried} shifts of boundary history carried in from the published Block 7 "
      f"(Block 7 has {last_week} filled shifts in its last 7 days)")
assert carried == last_week
print("\nALL DATA MODEL TESTS PASSED")
