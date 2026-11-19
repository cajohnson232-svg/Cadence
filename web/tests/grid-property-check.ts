// Property check: for many random role grids, what the compile step tells the engine about who may work each shift
// (a person's list of allowed shifts, or else the shift's minimum PGY level) equals the role grid and the person's
// institutions (as assigned for the interval), for every person
// and every shift template, special-day ones included.     npm run db:reset && npx tsx tests/grid-property-check.ts
import "dotenv/config";
import { db } from "../src/lib/db";
import { compileInterval } from "../src/lib/compile";
import { eligibilityMismatches } from "../src/lib/engine";

type R = { id: string; pgy: number; only_shifts?: string[] };
type T = { ref: string; min_pgy: number; name: string };
async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("This test changes data. It only runs against a database on localhost.");
  const shifts = await db.shift.findMany({ where: { programId: "prog_demo" } });
  const roles = await db.role.findMany({ where: { programId: "prog_demo" } });
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let bad = 0, checked = 0;
  for (let it = 0; it < Number(process.env.ITER ?? 150); it++) {
    // random levels too (several roles can share one), and a random grid with some rows missing
    await Promise.all(roles.map((r) => db.role.update({ where: { id: r.id }, data: { level: 1 + Math.floor(rnd() * 3) } })));
    await db.shiftRole.deleteMany({ where: { shiftId: { in: shifts.map((s) => s.id) } } });
    const rows = shifts.flatMap((s) => roles.filter(() => rnd() < 0.8).map((r) => ({ shiftId: s.id, roleId: r.id, eligible: rnd() < 0.6, requiredCount: 0 })));
    await db.shiftRole.createMany({ data: rows });
    const grid = new Map(rows.map((g) => [g.shiftId + "|" + g.roleId, g.eligible]));
    const instOf = new Map(shifts.map((x) => [x.id, x.institutionId]));
    const asg = await db.assignment.findMany({ where: { intervalId: "iv_7" }, include: { institutions: true } });
    const placesOf = (pid: string) => { const a = asg.filter((x) => x.participantId === pid); return a.some((x) => !x.institutions.length) ? null : new Set(a.flatMap((x) => x.institutions.map((i) => i.institutionId))); };
    const people = new Map((await db.participant.findMany({ where: { programId: "prog_demo" } })).map((p) => [p.id, p.roleId]));
    const c = await compileInterval("iv_7");
    for (const r of c.config.residents as R[]) for (const t of c.config.shift_templates as T[]) {
      checked++;
      const told = r.only_shifts ? r.only_shifts.includes(t.ref) : r.pgy >= t.min_pgy;
      const places = placesOf(r.id);
      const want = t.ref.startsWith("line:") ? false : (grid.get(t.ref + "|" + people.get(r.id)) ?? true) && (!places || places.has(instOf.get(t.ref)!));
      if (told !== want) { bad++; if (bad <= 5) console.log(`MISMATCH it ${it}: ${r.id} (${people.get(r.id)}) on ${t.name} [${t.ref}]: engine told ${told}, grid says ${want}`); }
    }
  }
  // and the independent check that runs before every engine run agrees: nothing to report
  const c = await compileInterval("iv_7");
  const wrong = await eligibilityMismatches("iv_7", c.config);
  if (wrong.length) { bad++; console.log("MISMATCH (pre-run check):", wrong.slice(0, 3)); }
  console.log(`${checked} person x shift pairs over ${process.env.ITER ?? 150} random grids: ${bad} mismatch(es)`);
  console.log(bad ? "GRID PROPERTY CHECK FAILED" : "GRID PROPERTY CHECK PASSED");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
