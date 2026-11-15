// Accounts: signing in, one-time links for choosing a password, and who has access to a program.
// The server actions in app/actions.ts check who is asking; the rules themselves live here.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";

export const cleanEmail = (v: string) => v.trim().toLowerCase();
export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;

// ───────────────────────────── slowing down guessing ─────────────────────────────
const WINDOW = 15 * 60_000, LOCK = 15 * 60_000;
const LIMIT = { email: 5, ip: 30 };            // failures inside the window before a lock

async function lockedFor(keys: string[]): Promise<number> {
  const rows = await db.signInThrottle.findMany({ where: { key: { in: keys }, lockedUntil: { gt: new Date() } } });
  return rows.length ? Math.max(...rows.map((r) => r.lockedUntil!.getTime())) - Date.now() : 0;
}
async function countFailure(key: string, limit: number) {
  const now = new Date(), row = await db.signInThrottle.findUnique({ where: { key } });
  await db.signInThrottle.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 86_400_000) } } });      // yesterday's counts are of no use; keeps the table small
  const fresh = !row || now.getTime() - row.windowStart.getTime() > WINDOW;
  const failures = fresh ? 1 : row.failures + 1;
  const data = { failures, windowStart: fresh ? now : row.windowStart, lockedUntil: failures >= limit ? new Date(now.getTime() + LOCK) : null };
  await db.signInThrottle.upsert({ where: { key }, create: { key, ...data }, update: data });
}
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
/** Counted per email address. Whatever was typed is stored only as a short fingerprint, however long it was. */
const emailKey = (email: string) => `email:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;

// ───────────────────────────── signing in ─────────────────────────────
export type SignInResult = { ok: true; user: { id: string; sessionVersion: number }; access: "ADMIN" | "CHIEF" | "RESIDENT" } | { ok: false; error: string };
const NO_MATCH = "That email and password do not match.";

/**
 * Check an email and password. The answer for a wrong password, an unknown email, an account with no
 * password yet and a switched-off account is the same, and takes the same time, so the form cannot be
 * used to find out who has an account.
 */
export async function signIn(emailRaw: string, password: string, ip: string | null): Promise<SignInResult> {
  const email = cleanEmail(emailRaw);
  const keys = [emailKey(email), ...(ip ? [`ip:${ip.slice(0, 64)}`] : [])];
  const wait = await lockedFor(keys);
  if (wait > 0) return { ok: false, error: `Too many attempts. Try again in ${minutes(wait)} minute${minutes(wait) === 1 ? "" : "s"}.` };
  const user = looksLikeEmail(email) ? await db.user.findUnique({ where: { email }, include: { memberships: { where: { program: { archivedAt: null } }, orderBy: { id: "asc" } } } }) : null;
  const usable = !!user && !user.disabledAt && user.memberships.length > 0;
  const good = await verifyPassword(password, usable ? user.passwordHash : null);
  if (!good || !usable) {
    await countFailure(keys[0], LIMIT.email);
    if (ip) await countFailure(keys[1], LIMIT.ip);
    return { ok: false, error: NO_MATCH };
  }
  await db.signInThrottle.deleteMany({ where: { key: keys[0] } });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { ok: true, user: { id: user.id, sessionVersion: user.sessionVersion }, access: user.memberships[0].access };
}

// ───────────────────────────── one-time links ─────────────────────────────
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
export const LINK_DAYS = { INVITE: 7, RESET: 1 } as const;

/** Make a one-time link for a person. Any earlier unused link of theirs stops working. Returns the token, which is not stored. */
export async function createAccessLink(userId: string, createdById: string | null): Promise<{ token: string; purpose: "INVITE" | "RESET"; expiresAt: Date }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const purpose = user.passwordHash ? "RESET" : "INVITE";
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_DAYS[purpose] * 86_400_000);
  await db.$transaction([
    db.accessLink.deleteMany({ where: { userId, usedAt: null } }),
    db.accessLink.create({ data: { userId, purpose, tokenHash: fingerprint(token), createdById, expiresAt } }),
  ]);
  return { token, purpose, expiresAt };
}

/** The link's owner if the link can still be used, otherwise null. Looking does not use it up. */
export async function readAccessLink(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const link = await db.accessLink.findUnique({ where: { tokenHash: fingerprint(token) }, include: { user: { include: { memberships: { include: { program: true }, orderBy: { id: "asc" } } } } } });
  if (!link || link.usedAt || link.expiresAt < new Date() || link.user.disabledAt || !link.user.memberships.length) return null;
  return link;
}

export type RedeemResult = { ok: true; user: { id: string; sessionVersion: number }; access: "ADMIN" | "CHIEF" | "RESIDENT" } | { ok: false; error: string; expired?: boolean };

/** Use a link: set the password, sign every other device out, and retire the link. */
export async function redeemAccessLink(token: string, password: string, again: string): Promise<RedeemResult> {
  const link = await readAccessLink(token);
  if (!link) return { ok: false, expired: true, error: "This link has expired or has already been used. Ask your program's administrator for a new one." };
  if (password !== again) return { ok: false, error: "The two passwords are not the same." };
  const problem = passwordProblem(password, link.user);
  if (problem) return { ok: false, error: problem };
  const passwordHash = await hashPassword(password);
  const claimed = await db.$transaction(async (tx) => {
    const used = await tx.accessLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!used.count) return null;                                   // someone used it a moment ago
    const user = await tx.user.update({ where: { id: link.userId }, data: { passwordHash, passwordSetAt: new Date(), sessionVersion: { increment: 1 }, lastLoginAt: new Date() } });
    await tx.signInThrottle.deleteMany({ where: { key: emailKey(user.email) } });
    return user;
  });
  if (!claimed) return { ok: false, expired: true, error: "This link has already been used. Ask your program's administrator for a new one." };
  return { ok: true, user: { id: claimed.id, sessionVersion: claimed.sessionVersion }, access: link.user.memberships[0].access };
}

/** Change your own password. Signs every other device out. */
export async function changePassword(userId: string, current: string, next: string, again: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(current, user.passwordHash))) return { ok: false as const, error: "Your current password is not right." };
  if (next !== again) return { ok: false as const, error: "The two new passwords are not the same." };
  const problem = passwordProblem(next, user) ?? (next === current ? "Choose a password different from your current one." : null);
  if (problem) return { ok: false as const, error: problem };
  const updated = await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next), passwordSetAt: new Date(), sessionVersion: { increment: 1 } } });
  return { ok: true as const, user: { id: updated.id, sessionVersion: updated.sessionVersion } };
}

// ───────────────────────────── who has access ─────────────────────────────
type Level = "ADMIN" | "CHIEF" | "RESIDENT";
type Outcome = { ok: true; userId: string } | { ok: false; error: string };

/** Administrators who can actually sign in. The program must always keep at least one. */
const workingAdmins = (programId: string) =>
  db.membership.count({ where: { programId, access: "ADMIN", user: { disabledAt: null, passwordHash: { not: null } } } });

/** Give a person access to a program. The person is found by email, or created. */
export async function grantAccess(programId: string, input: { name: string; email: string; access: Level; participantId?: string | null }): Promise<Outcome> {
  const email = cleanEmail(input.email), name = input.name.trim();
  if (!name) return { ok: false, error: "Enter the person's name." };
  if (!looksLikeEmail(email)) return { ok: false, error: "Enter a valid email address." };
  const participantId = input.participantId || null;
  if (participantId) {
    const p = await db.participant.findFirst({ where: { id: participantId, programId } });
    if (!p) return { ok: false, error: "That participant does not exist." };
    const taken = await db.membership.findFirst({ where: { participantId }, include: { user: true } });
    if (taken && taken.user.email !== email) return { ok: false, error: `That participant already signs in as ${taken.user.email}.` };
  }
  const user = await db.user.upsert({ where: { email }, create: { email, name }, update: {} });
  const existing = await db.membership.findUnique({ where: { programId_userId: { programId, userId: user.id } } });
  if (existing) {
    if (participantId && existing.participantId && existing.participantId !== participantId) return { ok: false, error: `${email} is already linked to a different participant.` };
    if (participantId && !existing.participantId) await db.membership.update({ where: { id: existing.id }, data: { participantId } });
  } else {
    await db.membership.create({ data: { programId, userId: user.id, access: input.access, participantId } });
  }
  return { ok: true, userId: user.id };
}

export async function setAccessLevel(programId: string, membershipId: string, access: Level, actingUserId: string): Promise<Outcome> {
  const m = await db.membership.findFirst({ where: { id: membershipId, programId }, include: { user: true } });
  if (!m) return { ok: false, error: "That person does not have access to this program." };
  if (m.access === access) return { ok: true, userId: m.userId };
  if (m.access === "ADMIN") {
    const isWorking = !m.user.disabledAt && !!m.user.passwordHash;
    if (isWorking && (await workingAdmins(programId)) <= 1) return { ok: false, error: "This is the only administrator who can sign in. Make someone else an administrator first." };
    if (m.userId === actingUserId) return { ok: false, error: "You cannot remove your own administrator access. Ask another administrator to do it." };
  }
  await db.membership.update({ where: { id: m.id }, data: { access } });
  return { ok: true, userId: m.userId };
}

/** Switch a person's sign-in off (they are signed out at once) or back on. */
export async function setSignInEnabled(programId: string, userId: string, enabled: boolean, actingUserId: string): Promise<Outcome> {
  const m = await db.membership.findFirst({ where: { userId, programId }, include: { user: true } });
  if (!m) return { ok: false, error: "That person does not have access to this program." };
  if (!enabled) {
    if (userId === actingUserId) return { ok: false, error: "You cannot switch off your own sign-in." };
    if (m.access === "ADMIN" && !m.user.disabledAt && m.user.passwordHash && (await workingAdmins(programId)) <= 1) return { ok: false, error: "This is the only administrator who can sign in." };
  }
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: enabled ? { disabledAt: null } : { disabledAt: new Date(), sessionVersion: { increment: 1 } } }),
    ...(enabled ? [] : [db.accessLink.deleteMany({ where: { userId, usedAt: null } })]),
  ]);
  return { ok: true, userId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
/**
 * A person who no longer has access to any program cannot sign in. Their password and links are
 * removed, and the account itself is deleted unless something still records it as its author.
 */
export async function retireIfNoAccess(tx: Tx, userId: string) {
  if (await tx.membership.count({ where: { userId } })) return;
  const authored = (await Promise.all([
    tx.timeOff.count({ where: { createdById: userId } }), tx.shiftAdjustment.count({ where: { createdById: userId } }),
    tx.rule.count({ where: { createdById: userId } }), tx.schedule.count({ where: { createdById: userId } }), tx.auditLog.count({ where: { userId } }),
  ])).some((n: number) => n > 0);
  if (authored) {
    await tx.accessLink.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { passwordHash: null, passwordSetAt: null, sessionVersion: { increment: 1 } } });
  } else {
    await tx.user.delete({ where: { id: userId } });
  }
}

/** Take a person's access to a program away altogether. (Switching sign-in off is the reversible alternative.) */
export async function removeAccess(programId: string, membershipId: string, actingUserId: string): Promise<Outcome> {
  const m = await db.membership.findFirst({ where: { id: membershipId, programId }, include: { user: true } });
  if (!m) return { ok: false, error: "That person does not have access to this program." };
  if (m.userId === actingUserId) return { ok: false, error: "You cannot remove your own access." };
  if (m.access === "ADMIN" && !m.user.disabledAt && m.user.passwordHash && (await workingAdmins(programId)) <= 1) return { ok: false, error: "This is the only administrator who can sign in." };
  await db.$transaction(async (tx) => {
    await tx.membership.delete({ where: { id: m.id } });
    await retireIfNoAccess(tx, m.userId);
  });
  return { ok: true, userId: m.userId };
}

/** The setup key is compared in constant time, so the comparison does not leak how much of a guess was right. */
export function setupKeyMatches(given: string): boolean {
  const want = process.env.SETUP_KEY ?? "";
  if (want.length < 16) return false;
  const a = createHash("sha256").update(given.trim()).digest(), b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}
export { countFailure as recordFailedAttempt, lockedFor as lockedForMs };
