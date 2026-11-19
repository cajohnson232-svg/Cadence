// Sign-in rules, checked directly (no browser): passwords, one-time links, guessing limits,
// who may change whom, first-time setup, and "start over".
//
//   npm run db:reset && npx tsx tests/accounts-check.ts
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { db } from "../src/lib/db";
import { hashPassword, passwordProblem, verifyPassword } from "../src/lib/passwords";
import {
  changePassword, createAccessLink, grantAccess, readAccessLink, redeemAccessLink, removeAccess, setAccessLevel, setSignInEnabled, setupKeyMatches, signIn,
} from "../src/lib/accounts";
import { runFirstSetup, setupNeeded, wipeProgram } from "../src/lib/program-setup";

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const PROG = "prog_demo", GOOD = "correct horse battery";

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("This test changes data. It only runs against a database on localhost.");

  // ── passwords ──
  const h = await hashPassword(GOOD);
  ok(h.startsWith("scrypt$32768$8$3$") && !h.includes(GOOD), "a password is stored as a salted scrypt result, never as itself");
  ok(h !== (await hashPassword(GOOD)), "the same password stored twice gives two different results (random salt)");
  ok(await verifyPassword(GOOD, h), "the right password is accepted");
  ok(!(await verifyPassword(GOOD + "x", h)) && !(await verifyPassword("", h)), "a wrong or empty password is refused");
  ok(!(await verifyPassword(GOOD, null)) && !(await verifyPassword(GOOD, "nonsense")), "an account with no password, or a damaged record, accepts nothing");
  const parts = h.split("$"); parts[5] = Buffer.from(Buffer.from(parts[5], "base64").map((b, i) => (i ? b : b ^ 1))).toString("base64");
  ok(!(await verifyPassword(GOOD, parts.join("$"))), "a stored result changed by one bit no longer matches");
  ok(passwordProblem("short") && passwordProblem("password123") && passwordProblem("aaaaaaaaaaaa"), "short, very common and single-character passwords are refused");
  ok(passwordProblem("adamsrules2027", { email: "adams@example.org" }) !== null && passwordProblem(GOOD, { email: "adams@example.org", name: "Avery Adams" }) === null, "an email-based password is refused; an ordinary long one is accepted");

  // ── signing in and the guessing limit ──
  await db.signInThrottle.deleteMany();
  const admin = await db.user.findUniqueOrThrow({ where: { email: "coordinator@example.org" } });
  ok((await signIn("Coordinator@Example.org ", "cadence-demo-2027", null)).ok, "sign-in works, and ignores capitals and spaces in the email");
  const wrong = await signIn("adams@example.org", "wrong-password", null), unknown = await signIn("nobody@example.org", "wrong-password", null);
  ok(!wrong.ok && !unknown.ok && wrong.error === unknown.error, "a wrong password and an unknown email get exactly the same answer");
  for (let i = 0; i < 4; i++) await signIn("adams@example.org", "wrong-password", null);
  const locked = await signIn("adams@example.org", "cadence-demo-2027", null);
  ok(!locked.ok && /Too many attempts/.test(locked.error), "after 5 wrong passwords the account is locked, even for the right password");
  for (let i = 0; i < 4; i++) await signIn("nobody@example.org", "wrong-password", null);
  const lockedUnknown = await signIn("nobody@example.org", "x", null);
  ok(!lockedUnknown.ok && /Too many attempts/.test(lockedUnknown.error), "an unknown email is limited in the same way, so the limit does not reveal who has an account");
  ok((await signIn("nguyen@example.org", "cadence-demo-2027", null)).ok, "other people are not affected by someone else's lock");
  ok(!(JSON.stringify(await db.signInThrottle.findMany())).includes("adams@"), "what was typed into the email box is kept only as a fingerprint");
  await db.signInThrottle.updateMany({ where: { lockedUntil: { not: null } }, data: { lockedUntil: new Date(Date.now() - 1000), windowStart: new Date(Date.now() - 16 * 60_000) } });
  ok((await signIn("adams@example.org", "cadence-demo-2027", null)).ok, "the lock ends after 15 minutes");
  for (let i = 0; i < 30; i++) await signIn(`person${i}@example.org`, "wrong-password", "203.0.113.9");
  const ipLocked = await signIn("nguyen@example.org", "cadence-demo-2027", "203.0.113.9");
  ok(!ipLocked.ok && /Too many attempts/.test(ipLocked.error) && (await signIn("nguyen@example.org", "cadence-demo-2027", "203.0.113.10")).ok, "30 wrong tries from one network address lock that address, not everyone");
  await signIn("x".repeat(100_000) + "@example.org", "wrong-password", null);
  ok((await db.signInThrottle.findMany()).every((r) => r.key.length <= 70), "an absurdly long email does not end up stored");
  await db.signInThrottle.updateMany({ data: { windowStart: new Date(Date.now() - 2 * 86_400_000), lockedUntil: null } });
  await signIn("someone@example.org", "wrong-password", null);
  ok((await db.signInThrottle.count()) === 1, "old attempt counts are cleared out as new ones arrive");
  await db.signInThrottle.deleteMany();

  // ── one-time links ──
  const adams = await db.user.findUniqueOrThrow({ where: { email: "adams@example.org" } });
  const reset = await createAccessLink(adams.id, admin.id);
  ok(reset.purpose === "RESET" && /^[A-Za-z0-9_-]{43}$/.test(reset.token), "someone who has a password gets a reset link, with an unguessable 256-bit token");
  ok((await db.accessLink.count({ where: { tokenHash: reset.token } })) === 0 && !(JSON.stringify(await db.accessLink.findMany())).includes(reset.token), "the link itself is not in the database, only its fingerprint");
  ok(!!(await readAccessLink(reset.token)) && !(await readAccessLink(reset.token.slice(0, -1) + (reset.token.endsWith("A") ? "B" : "A"))) && !(await readAccessLink("../../etc")), "the right link is recognised; a link one character off, or nonsense, is not");
  const second = await createAccessLink(adams.id, admin.id);
  ok(!(await readAccessLink(reset.token)) && !!(await readAccessLink(second.token)), "making a new link stops the previous one working");
  const bad = await redeemAccessLink(second.token, "short", "short");
  ok(!bad.ok && !!(await readAccessLink(second.token)), "a refused password does not use the link up");
  const mismatch = await redeemAccessLink(second.token, GOOD, GOOD + "!");
  ok(!mismatch.ok && /not the same/.test(mismatch.error), "the two passwords must match");
  const before = adams.sessionVersion;
  const used = await redeemAccessLink(second.token, GOOD, GOOD);
  ok(used.ok && used.user.sessionVersion === before + 1, "using the link sets the password and signs every other device out");
  const again = await redeemAccessLink(second.token, "another long password", "another long password");
  ok(!again.ok && again.expired, "a link works once");
  ok((await signIn("adams@example.org", GOOD, null)).ok && !(await signIn("adams@example.org", "cadence-demo-2027", null)).ok, "the new password works and the old one does not");
  await db.signInThrottle.deleteMany();
  const old = await createAccessLink(adams.id, admin.id);
  await db.accessLink.updateMany({ where: { userId: adams.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  ok(!(await readAccessLink(old.token)) && !(await redeemAccessLink(old.token, GOOD + "2", GOOD + "2")).ok, "an expired link is refused");
  const both = await createAccessLink(adams.id, admin.id);
  const race = await Promise.all([redeemAccessLink(both.token, "first long password", "first long password"), redeemAccessLink(both.token, "second long password", "second long password")]);
  ok(race.filter((r) => r.ok).length === 1, "two people using the same link at the same moment: exactly one succeeds");

  // ── changing your own password ──
  await db.user.update({ where: { id: adams.id }, data: { passwordHash: await hashPassword(GOOD) } });
  ok(!(await changePassword(adams.id, "not my password", "brand new password 1", "brand new password 1")).ok, "changing a password needs the current one");
  ok(!(await changePassword(adams.id, GOOD, GOOD, GOOD)).ok, "the new password must differ from the current one");
  const changed = await changePassword(adams.id, GOOD, "brand new password 1", "brand new password 1");
  ok(changed.ok && (await signIn("adams@example.org", "brand new password 1", null)).ok, "a changed password works straight away");

  // ── who may change whom ──
  const me = await db.membership.findFirstOrThrow({ where: { userId: admin.id } });
  ok(!(await setAccessLevel(PROG, me.id, "CHIEF", admin.id)).ok, "the only administrator who can sign in cannot be demoted");
  ok(!(await setSignInEnabled(PROG, admin.id, false, admin.id)).ok, "nor switch off their own sign-in");
  ok(!(await removeAccess(PROG, me.id, admin.id)).ok, "nor remove their own access");
  const g = await grantAccess(PROG, { name: "Sam Second", email: " Sam@Example.ORG ", access: "ADMIN" });
  ok(g.ok && (await db.user.findUnique({ where: { email: "sam@example.org" } }))?.name === "Sam Second", "a new administrator is added, with the email stored in lower case");
  if (!g.ok) throw new Error(g.error);
  const sam = await db.membership.findFirstOrThrow({ where: { userId: g.userId } });
  ok(!(await setAccessLevel(PROG, me.id, "CHIEF", g.userId)).ok, "an invited administrator who has not chosen a password yet does not count: the working one still cannot be demoted");
  await db.user.update({ where: { id: g.userId }, data: { passwordHash: await hashPassword(GOOD) } });
  ok((await setAccessLevel(PROG, me.id, "CHIEF", g.userId)).ok && (await setAccessLevel(PROG, me.id, "ADMIN", g.userId)).ok, "once a second administrator can sign in, the first can be changed by them");
  ok(!(await setAccessLevel(PROG, sam.id, "CHIEF", g.userId)).ok, "nobody can remove their own administrator access");
  let refused = false;
  try { await db.user.create({ data: { email: "Capital@Example.org", name: "x" } }); } catch { refused = true; }
  ok(refused, "the database itself refuses an email address that is not lower case");
  const dup = await grantAccess(PROG, { name: "Somebody Else", email: "brooks@example.org", access: "RESIDENT", participantId: "p01" });
  ok(!dup.ok && /already signs in as adams@example.org/.test(dup.error), "one participant cannot be linked to two sign-ins");
  ok(!(await grantAccess(PROG, { name: "X", email: "not-an-email", access: "CHIEF" })).ok, "an invalid email address is refused");
  const off = await setSignInEnabled(PROG, adams.id, false, admin.id);
  const afterOff = await db.user.findUniqueOrThrow({ where: { id: adams.id } });
  ok(off.ok && afterOff.disabledAt && afterOff.sessionVersion > adams.sessionVersion + 1 && !(await signIn("adams@example.org", "brand new password 1", null)).ok, "switching a sign-in off signs the person out and refuses their password");
  await db.signInThrottle.deleteMany();
  await setSignInEnabled(PROG, adams.id, true, admin.id);
  ok((await signIn("adams@example.org", "brand new password 1", null)).ok, "switching it back on lets them in again with the same password");
  const adamsM = await db.membership.findFirstOrThrow({ where: { userId: adams.id } });
  ok((await removeAccess(PROG, adamsM.id, admin.id)).ok && !(await signIn("adams@example.org", "brand new password 1", null)).ok && !!(await db.participant.findUnique({ where: { id: "p01" } })), "removing access stops sign-in and leaves the participant and their schedule alone");
  await db.signInThrottle.deleteMany();

  // ── setup key ──
  process.env.SETUP_KEY = "a-long-setup-key-0123456789";
  ok(setupKeyMatches("a-long-setup-key-0123456789") && setupKeyMatches("  a-long-setup-key-0123456789 ") && !setupKeyMatches("a-long-setup-key-012345678") && !setupKeyMatches(""), "the setup key must match exactly");
  process.env.SETUP_KEY = "short";
  ok(!setupKeyMatches("short"), "a setup key shorter than 16 characters is never accepted");
  ok(!(await setupNeeded()) && !(await runFirstSetup({ name: "Mallory", email: "m@example.org", password: GOOD, again: GOOD, programName: "Mine", timezone: "America/Chicago", start: "empty" })).ok, "setup refuses to run once anybody can sign in");

  // ── start over: only this program, administrators keep their sign-in ──
  const other = await db.program.create({ data: { name: "Other Residency", shortCode: "OTHER" } });
  await db.institution.create({ data: { programId: other.id, name: "Elsewhere General", shortCode: "EG", timezone: "America/Chicago" } });
  const outsider = await db.user.create({ data: { email: "outsider@example.org", name: "Outsider", passwordHash: await hashPassword(GOOD) } });
  await db.membership.create({ data: { programId: other.id, userId: outsider.id, access: "ADMIN" } });
  const tables = ["Institution", "Area", "Role", "Participant", "ShiftCategory", "Shift", "ShiftRole", "Interval", "Assignment", "SpecialStaffingDay", "AcademicDay", "TimeOff", "ShiftAdjustment", "Rule", "Schedule", "ScheduledShift", "AuditLog"];
  await wipeProgram(PROG);
  const left: Record<string, number> = {};
  for (const t of tables) left[t] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0].n);
  ok(left.Participant === 0 && left.Shift === 0 && left.Interval === 0 && left.Assignment === 0 && left.Schedule === 0 && left.ScheduledShift === 0 && left.TimeOff === 0 && left.AcademicDay === 0 && left.SpecialStaffingDay === 0 && left.ShiftAdjustment === 0 && left.AuditLog === 0,
    "start over removes the program's people, shifts, intervals, time off, schedules and history");
  ok(left.Institution === 1 && (await db.institution.count({ where: { programId: other.id } })) === 1 && (await signIn("outsider@example.org", GOOD, null)).ok, "another program's data and people are untouched");
  ok((await db.rule.count({ where: { programId: PROG, source: "SYSTEM" } })) === 13 && left.Rule === 13 && (await db.shiftCategory.count({ where: { programId: PROG } })) === 3 && (await db.role.count({ where: { programId: PROG } })) === 4, "the standard 13 rules, 3 shift categories and 4 PGY roles are put back");
  const stay = (await db.membership.findMany({ where: { programId: PROG }, include: { user: true } })).map((m) => `${m.user.email}:${m.access}`).sort();
  ok(stay.join() === "coordinator@example.org:ADMIN,sam@example.org:ADMIN", `administrators keep their access; chiefs and residents lose it (${stay.join(", ")})`);
  ok((await signIn("coordinator@example.org", "cadence-demo-2027", null)).ok && !(await signIn("nguyen@example.org", "cadence-demo-2027", null)).ok && !(await db.user.findUnique({ where: { email: "nguyen@example.org" } })), "an administrator can still sign in; a removed chief cannot, and their account is gone");

  // ── first-time setup on a brand-new database ──
  const url = process.env.DATABASE_URL!;
  execFileSync("npx", ["tsx", "scripts/reset-db.ts", "--empty"], { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
  ok(await setupNeeded(), "a brand-new database needs setting up");
  ok(!(await runFirstSetup({ name: "Dana Director", email: "dana@example.org", password: "short", again: "short", programName: "Riverside EM", timezone: "America/Chicago", start: "empty" })).ok && (await db.program.count()) === 0, "setup with a weak password creates nothing");
  const two = await Promise.all([
    runFirstSetup({ name: "Dana Director", email: "Dana@Example.org", password: GOOD, again: GOOD, programName: "Riverside EM", timezone: "America/Denver", start: "empty" }),
    runFirstSetup({ name: "Mallory", email: "mallory@example.org", password: GOOD, again: GOOD, programName: "Takeover", timezone: "America/Chicago", start: "empty" }),
  ]);
  ok(two.filter((r) => r.ok).length === 1 && (await db.user.count({ where: { passwordHash: { not: null } } })) === 1 && (await db.program.count()) === 1, "two people submitting setup at the same moment: one becomes the administrator, the other is refused, and one program exists");
  const prog = await db.program.findFirstOrThrow();
  ok((await db.rule.count({ where: { programId: prog.id } })) === 13 && (await db.shiftCategory.count()) === 3 && (await db.role.count()) === 4 && (await db.participant.count()) === 0, "an empty program starts with the standard rules, categories and roles, and nobody in it");
  ok(!(await setupNeeded()), "after that, setup is closed");
  execFileSync("npx", ["tsx", "scripts/reset-db.ts", "--empty"], { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
  const demo = await runFirstSetup({ name: "Dana Director", email: "dana@example.org", password: GOOD, again: GOOD, programName: "", timezone: "America/Chicago", start: "demo" });
  ok(demo.ok && (await db.participant.count()) === 18 && (await db.interval.count()) >= 2, "setup with the demo program loads its 18 made-up people and intervals");
  ok((await db.user.count({ where: { passwordHash: { not: null } } })) === 1 && !(await signIn("coordinator@example.org", "cadence-demo-2027", null)).ok && (await signIn("dana@example.org", GOOD, null)).ok,
    "on a hosted site the demo people have no password at all; only the person who ran setup can sign in");
  const mine = await db.membership.findFirstOrThrow({ where: { user: { email: "dana@example.org" } } });
  ok(mine.access === "ADMIN" && mine.programId === "prog_demo", "and that person is the demo program's administrator");

  console.log(failed ? `\n${failed} FAILED` : "\nACCOUNT CHECKS PASSED");
  execFileSync("npx", ["tsx", "scripts/reset-db.ts"], { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
