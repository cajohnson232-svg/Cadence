"""What is STORED for a schedule must itself pass the engine's independent rule check.

The engine checks its own result before the app imports it. This test checks the other half: it reads
the shifts back out of the database, rebuilds who-works-what from those rows alone, and runs the same
independent checker on them against the inputs the schedule was built from. It also checks every
stored start and end time against the shift it stands for.

It starts the run in one process that exits straight away and collects it from another, so it also
shows that a run does not depend on the process that started it (a web server restart, for example).

    npm run db:reset && python tests/verify_stored.py          (from web/; set ENGINE_BACKEND=highs or cpsat to choose)
"""
import json, os, subprocess, sys
from datetime import datetime, timedelta
WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(WEB)
sys.path.insert(0, ROOT)
from cadence.problem import Problem                              # noqa: E402
from cadence import validator                                    # noqa: E402

url = next(l.split("=", 1)[1].strip().strip('"') for l in open(os.path.join(WEB, ".env")) if l.startswith("DATABASE_URL"))
INTERVAL = sys.argv[1] if len(sys.argv) > 1 else "iv_7"
fails = 0


def ok(cond, what):
    global fails
    print(("ok   " if cond else "FAIL ") + what)
    fails += 0 if cond else 1


def db(sql):
    r = subprocess.run(["psql", url, "-At", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                       input=f"SELECT coalesce(json_agg(row_), '[]'::json) FROM ({sql}) row_", text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-500:])
    return json.loads(r.stdout)


def tsx(*args):
    return subprocess.run(["npx", "tsx", "tests/make-schedule.ts", *args], cwd=WEB, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]


sid = tsx("start", INTERVAL, "12", "6")
row = db(f"""SELECT "runStatus", "workerPid" FROM "Schedule" WHERE id = '{sid}'""")[0]
ok(row["runStatus"] == "RUNNING", "the process that started the run has exited and the run is still going")
ok(tsx("wait", sid) == "DONE", "a different process collects the result and imports it")

sch = db(f"""SELECT "inputSnapshot", report FROM "Schedule" WHERE id = '{sid}'""")[0]
every = db(f"""SELECT "participantId", "shiftId", "specialStaffingShiftId", name, "dutyDate", "startsAt", "endsAt", backup FROM "ScheduledShift" WHERE "scheduleId" = '{sid}'""")
rows = [r for r in every if not r["backup"]]                  # clinical shifts; backup (on-call) days are checked separately below
brows = [r for r in every if r["backup"]]
P = Problem(sch["inputSnapshot"])
start = datetime.combine(P.start_date, datetime.min.time())
minutes = lambda t: int((datetime.fromisoformat(t) - start).total_seconds() // 60)          # noqa: E731

# every stored row must be exactly one of the shifts the inputs ask for: same day, same name, same clock times
by_key = {}
for s in P.slot_list:
    by_key.setdefault((s.day, s.name, s.start, s.end), []).append(s)
assignment, unmatched, seats = {r.id: [] for r in P.residents}, 0, {}
for r in rows:
    day = (datetime.fromisoformat(r["dutyDate"]) - start).days
    slots = by_key.get((day, r["name"], minutes(r["startsAt"]), minutes(r["endsAt"])))
    if not slots:
        unmatched += 1
        continue
    s = slots[0]
    if r["shiftId"] is not None and r["shiftId"] != s.ref:          # the row points at a different shift template than the one it stands for
        unmatched += 1
    seats[s.key] = seats.get(s.key, 0) + 1
    if r["participantId"]:
        assignment[r["participantId"]].append(s.key)
ok(unmatched == 0, f"every stored row matches a shift in the inputs by day, name and clock time ({len(rows)} rows)")
ok(all(seats.get(s.key, 0) == s.need for s in P.slot_list), "every shift has exactly as many rows as people it needs (filled or open)")

V, opens, short = validator.validate(P, assignment)
n_open = sum(n for _, n in opens)
ok(not V, f"the independent checker, run on the stored rows, finds no hard-rule violation ({len(V)})")
for v in V[:5]:
    print("     ", v)
rep = sch["report"]
ok(n_open == rep["validator"]["open_shifts"] == sum(1 for r in rows if not r["participantId"]), f"open shifts agree: stored rows, checker and report ({n_open})")
ok(len(short) == len(rep["validator"]["under_contract_minimum"]), "people under their contract minimum agree with the report")
soft = validator.soft_metrics(P, assignment)
scale = {"day/evening/night balance": 10.0, "site split": 100.0}
ok(all(abs(g["score"] - (n_open if g["name"] == "open shifts" else soft.get(g["name"], 0) / scale.get(g["name"], 1.0))) < 1e-6 for g in rep["goals"]),
   "every goal score in the report is reproduced from the stored rows")
peak = validator.duty_stats(P, assignment)["peak_rolling_7day_hours"]
ok(abs(peak - rep["duty"]["peak_rolling_7day_hours"]) < 1e-6 and peak <= P.rules.max_week_minutes / 60, f"most hours in any 7 days: {peak:g}, within the limit of {P.rules.max_week_minutes / 60:g}")
# backup days: rebuild them from the stored rows alone and run the independent backup checker on them
from cadence import backup                                           # noqa: E402
blines = backup.lines(P)
bdays, bunmatched = {}, 0
for r in brows:
    day = (datetime.fromisoformat(r["dutyDate"]) - start).days
    a, b = minutes(r["startsAt"]), minutes(r["endsAt"])
    L = next((l for l in blines if l.name == r["name"] and l.window(day) == (a, b)), None)
    if L is None:
        bunmatched += 1
        continue
    e = bdays.setdefault((day, L.k), {"day": day, "line": L.k, "start": a, "end": b, "assigned": []})
    if r["participantId"]:
        e["assigned"].append(r["participantId"])
ok(bunmatched == 0 and len(brows) > 0 if blines else not brows, f"every stored backup row matches a backup shift of the inputs ({len(brows)} rows)")
BV = backup.check(P, assignment, {"days": list(bdays.values())})
ok(not BV, f"the independent backup checker, run on the stored rows, finds nothing wrong ({len(BV)})")
for v in BV[:5]:
    print("     ", v)
rb = rep.get("backup") or {}
ok(sum(1 for e in bdays.values() if e["assigned"]) == sum(1 for e in rb.get("days", []) if e["assigned"]), "backup days filled agree: stored rows and report")
print(f"engine used: {rep['engine']['backend']}, {rep['engine']['strategy']}")
subprocess.run(["psql", url, "-q", "-c", f"""DELETE FROM "Schedule" WHERE id = '{sid}'"""], check=True)
print("STORED SCHEDULE CHECK PASSED" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
