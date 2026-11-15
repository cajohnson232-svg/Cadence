"""The app (TypeScript) and the engine bridge (Python) must compile the SAME engine input from
the same database, and the engine must be able to schedule from the app's version.

    npm run db:reset && python tests/compare_compile.py          (from web/, with DATABASE_URL's server running)
"""
import json, os, subprocess, sys
WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(WEB)
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "datamodel"))
import compile_interval as ci                                   # noqa: E402
from cadence.problem import Problem                             # noqa: E402
from cadence import solver, validator                           # noqa: E402

url = next(l.split("=", 1)[1].strip().strip('"') for l in open(os.path.join(WEB, ".env")) if l.startswith("DATABASE_URL"))


def db(sql, fetch=True):
    q = f"SELECT coalesce(json_agg(row_), '[]'::json) FROM ({sql}) row_" if fetch else sql
    r = subprocess.run(["psql", url, "-At", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], input=q, text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-500:])
    return json.loads(r.stdout) if fetch else None


def norm(x):
    """Same content regardless of key order, list order of templates/residents, or 1 vs 1.0."""
    if isinstance(x, dict):
        return {k: norm(v) for k, v in sorted(x.items())}
    if isinstance(x, list):
        items = [norm(v) for v in x]
        return sorted(items, key=lambda v: json.dumps(v, sort_keys=True)) if items and isinstance(items[0], (dict, str)) else items
    if isinstance(x, float) and x == int(x):
        return int(x)
    return x


ok = True
for interval in ("iv_7",):
    ts = json.loads(subprocess.run(["npx", "tsx", "tests/compile-check.ts", interval], cwd=WEB, capture_output=True, text=True, check=True).stdout)
    py = ci.compile_interval(db, interval)
    a, b = norm(ts["config"]), norm(json.loads(json.dumps(py["config"], default=str)))
    for key in sorted(set(a) | set(b)):
        same = a.get(key) == b.get(key)
        ok &= same
        print(f"{'same' if same else 'DIFFERENT':<10} {key}")
        if not same:
            sa, sb = json.dumps(a.get(key), sort_keys=True), json.dumps(b.get(key), sort_keys=True)
            i = next((i for i, (x, y) in enumerate(zip(sa, sb)) if x != y), min(len(sa), len(sb)))
            print("   app   :", sa[max(0, i - 120):i + 160]); print("   bridge:", sb[max(0, i - 120):i + 160])
    ca = sorted((r[0], r[1], r[2], r[3], r[4]) for r in ts["compiled"])
    cb = sorted((r["origin"], r["id"], r["engine"], r.get("level", ""), r["text"]) for r in py["compiled_rules"])
    same = ca == cb
    ok &= same
    print(f"{'same' if same else 'DIFFERENT':<10} compiled rules list ({len(ca)} vs {len(cb)} entries)")
    if not same:
        for x, y in zip(ca, cb):
            if x != y:
                print("   app   :", x); print("   bridge:", y); break
    same = sorted(ts["warnings"]) == sorted(py["warnings"])
    ok &= same
    print(f"{'same' if same else 'DIFFERENT':<10} warnings ({len(ts['warnings'])})")
    if not same:
        print("   app   :", sorted(ts["warnings"])); print("   bridge:", sorted(py["warnings"]))

    # and the engine can schedule straight from what the app exports
    P = Problem(ts["config"])
    S = solver.Scheduler(P, log=lambda m: None, seed=1)
    out = S.run(seconds=float(os.environ.get("SECONDS_EXACT", 20)), polish_seconds=15)
    V, opens, short = validator.validate(P, out["assignment"])
    print(f"engine run from the app's export: {sum(s.need for s in P.slot_list)} shifts, {len(V)} hard-rule violations, "
          f"{sum(n for _, n in opens)} open, {len(short)} under contract minimum")
    ok &= not V
print("COMPILE CHECK PASSED" if ok else "COMPILE CHECK FAILED")
sys.exit(0 if ok else 1)
