// Starting a program: the first-time setup of a new site, the starting contents of an empty
// program, the made-up demo program, and "start over".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { db } from "./db";
import { cleanEmail, looksLikeEmail, retireIfNoAccess } from "./accounts";
import { hashPassword, passwordProblem } from "./passwords";
import templates from "./rule-templates.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
export const DEMO_PROGRAM_ID = "prog_demo";

/** A site needs setting up while nobody is able to sign in. */
export async function setupNeeded(): Promise<boolean> {
  return (await db.user.count({ where: { passwordHash: { not: null } } })) === 0;
}

/** What every new program starts with: the standard rules (all editable), shift categories and roles. */
export async function addProgramDefaults(tx: Tx, programId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (templates as any).systemRules as { template: string; level: "HARD" | "SOFT"; params: object; weight?: number; priority?: number }[])
    await tx.rule.create({ data: { programId, scope: "PROGRAM", template: r.template, params: r.params, level: r.level, weight: r.weight ?? null, priority: r.priority ?? null, source: "SYSTEM" } });
  await tx.shiftCategory.createMany({ data: [
    { programId, name: "Day", sortOrder: 0, isNight: false },
    { programId, name: "Evening", sortOrder: 1, isNight: false },
    { programId, name: "Night", sortOrder: 2, isNight: true },
  ] });
  await tx.role.createMany({ data: [1, 2, 3, 4].map((level) => ({ programId, name: `PGY-${level}`, level })) });
}

/** Load the made-up demo program (18 people, two hospitals, one interval ready to schedule). Only into a database with no programs. */
async function loadDemoProgram() {
  const sql = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), "prisma", "seed_demo.sql"), "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

const shortCode = async (tx: Tx, name: string) => {
  const base = (name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 10) || "PROGRAM");
  for (let i = 0; ; i++) {
    const code = i ? `${base}${i + 1}` : base;
    if (!(await tx.program.findUnique({ where: { shortCode: code } }))) return code;
  }
};

export type SetupInput = { name: string; email: string; password: string; again: string; programName: string; timezone: string; start: "demo" | "empty" };
export type SetupResult = { ok: true; user: { id: string; sessionVersion: number } } | { ok: false; error: string };

/**
 * Create the first administrator and their program. Works once: as soon as anybody can sign in, it refuses.
 * The caller has already checked the setup key.
 */
export async function runFirstSetup(input: SetupInput): Promise<SetupResult> {
  const email = cleanEmail(input.email), name = input.name.trim(), programName = input.programName.trim();
  if (!name) return { ok: false, error: "Enter your name." };
  if (!looksLikeEmail(email)) return { ok: false, error: "Enter a valid email address." };
  if (input.start === "empty" && !programName) return { ok: false, error: "Enter your program's name." };
  if (input.password !== input.again) return { ok: false, error: "The two passwords are not the same." };
  const problem = passwordProblem(input.password, { email, name });
  if (problem) return { ok: false, error: problem };
  if (!(await setupNeeded())) return { ok: false, error: "This site has already been set up. Sign in instead." };

  if (input.start === "demo" && !(await db.program.count())) await loadDemoProgram();
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7203001)`;          // two people submitting the form at once: one waits, then is refused
    if (await tx.user.count({ where: { passwordHash: { not: null } } })) return { ok: false as const, error: "This site has already been set up. Sign in instead." };
    let program = await tx.program.findFirst({ where: input.start === "demo" ? { id: DEMO_PROGRAM_ID } : {}, orderBy: { createdAt: "asc" } });
    if (!program) {
      program = await tx.program.create({ data: { name: programName || "My program", shortCode: await shortCode(tx, programName || "My program"), timezone: input.timezone || "America/Chicago" } });
      await addProgramDefaults(tx, program.id);
    } else if (input.start === "demo") {
      await tx.program.update({ where: { id: program.id }, data: { timezone: input.timezone || program.timezone } });
    }
    const user = await tx.user.upsert({
      where: { email },
      create: { email, name, passwordHash, passwordSetAt: new Date(), lastLoginAt: new Date() },
      update: { name, passwordHash, passwordSetAt: new Date(), lastLoginAt: new Date(), disabledAt: null },
    });
    await tx.membership.upsert({
      where: { programId_userId: { programId: program.id, userId: user.id } },
      create: { programId: program.id, userId: user.id, access: "ADMIN" }, update: { access: "ADMIN" },
    });
    return { ok: true as const, user: { id: user.id, sessionVersion: user.sessionVersion } };
  });
}

/**
 * Start over: remove everything a program holds (people, shifts, intervals, rules, schedules, history)
 * and put back the starting contents of an empty program. Administrators keep their sign-in;
 * everybody else's access to this program is removed. Other programs are not touched.
 */
export async function wipeProgram(programId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const p = programId;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Schedule" WHERE "intervalId" IN (SELECT id FROM "Interval" WHERE "programId" = ${p})`;       // its shifts go with it
    await tx.$executeRaw`DELETE FROM "TimeOff" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "ShiftAdjustment" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Rule" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "AcademicDay" WHERE "programId" = ${p}`;                // roles, occurrences, exceptions go with it
    await tx.$executeRaw`DELETE FROM "SpecialStaffingDay" WHERE "programId" = ${p}`;         // its lines go with it
    await tx.$executeRaw`DELETE FROM "Assignment" WHERE "programId" = ${p}`;                 // its institution and shift lists go with it
    await tx.$executeRaw`DELETE FROM "Interval" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Shift" WHERE "programId" = ${p}`;                      // its role settings go with it
    const leaving: { userId: string }[] = await tx.membership.findMany({ where: { programId: p, access: { not: "ADMIN" } }, select: { userId: true } });
    await tx.$executeRaw`DELETE FROM "Membership" WHERE "programId" = ${p} AND access <> 'ADMIN'`;
    await tx.$executeRaw`UPDATE "Membership" SET "participantId" = NULL WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Participant" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Area" WHERE "institutionId" IN (SELECT id FROM "Institution" WHERE "programId" = ${p})`;
    await tx.$executeRaw`DELETE FROM "Institution" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "Role" WHERE "programId" = ${p}`;
    await tx.$executeRaw`DELETE FROM "ShiftCategory" WHERE "programId" = ${p}`;
    for (const { userId } of leaving) await retireIfNoAccess(tx, userId);       // people left with no access anywhere lose their sign-in
    await addProgramDefaults(tx, p);
  }, { timeout: 60_000 });
}
