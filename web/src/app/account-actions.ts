"use server";
// Signing in, choosing a password from a one-time link, first-time setup, and managing who has access.
// Every action here checks who is asking before it does anything; the rules themselves are in lib/accounts.ts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { clientAddress, endSession, getSession, requireOwner, requireSession, siteOrigin, startSession } from "@/lib/auth";
import {
  changePassword, createAccessLink, grantAccess, lockedForMs, recordFailedAttempt, redeemAccessLink, removeAccess,
  setAccessLevel, setSignInEnabled, setupKeyMatches, signIn,
} from "@/lib/accounts";
import { runFirstSetup, setupNeeded, wipeProgram } from "@/lib/program-setup";

export type FormMsg = { error?: string; notice?: string; expired?: boolean; at?: number } | null;
export type LinkResult = { ok: true; link: string; purpose: "INVITE" | "RESET"; expires: string; email: string } | { ok: false; error: string };
type Done = { ok: true } | { ok: false; error: string };

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const home = (access: string) => (access === "RESIDENT" ? "/me" : "/intervals");
const record = (s: { programId: string; userId: string }, entityId: string, action: string, changes?: object) =>
  db.auditLog.create({ data: { programId: s.programId, userId: s.userId, entity: "User", entityId, action, changes } });

// ───────────────────────────── sign in / out ─────────────────────────────
export async function signInAction(_prev: FormMsg, fd: FormData): Promise<FormMsg> {
  const r = await signIn(text(fd, "email"), text(fd, "password"), await clientAddress());
  if (!r.ok) return { error: r.error, at: Date.now() };
  await startSession(r.user);
  redirect(home(r.access));
}

export async function joinAction(token: string, _prev: FormMsg, fd: FormData): Promise<FormMsg> {
  const r = await redeemAccessLink(token, text(fd, "password"), text(fd, "again"));
  if (!r.ok) return { error: r.error, expired: r.expired, at: Date.now() };
  await startSession(r.user);
  redirect(home(r.access));
}

export async function changePasswordAction(_prev: FormMsg, fd: FormData): Promise<FormMsg> {
  const s = await requireSession();
  const r = await changePassword(s.userId, text(fd, "current"), text(fd, "password"), text(fd, "again"));
  if (!r.ok) return { error: r.error, at: Date.now() };
  await startSession(r.user);                       // this device stays signed in; every other one is signed out
  await record(s, s.userId, "change-password");
  return { notice: "Password changed. Any other device you were signed in on has been signed out.", at: Date.now() };
}

// ───────────────────────────── first-time setup ─────────────────────────────
export async function setupAction(_prev: FormMsg, fd: FormData): Promise<FormMsg> {
  if (!(await setupNeeded())) redirect("/login");
  const ip = await clientAddress();
  const wait = ip ? await lockedForMs([`setup:${ip}`]) : 0;
  if (wait > 0) return { error: "Too many attempts. Try again in 15 minutes.", at: Date.now() };
  // On a real server the setup key is always required. On a developer's own machine it is only required if one is set.
  const keyRequired = process.env.NODE_ENV === "production" || !!process.env.SETUP_KEY;
  if (keyRequired && !setupKeyMatches(text(fd, "key"))) {
    if (ip) await recordFailedAttempt(`setup:${ip}`, 10);
    return { error: process.env.SETUP_KEY ? "That setup key is not right." : "This server has no SETUP_KEY, so it cannot be set up yet. Add one in the hosting service's settings.", at: Date.now() };
  }
  const r = await runFirstSetup({
    name: text(fd, "name"), email: text(fd, "email"), password: text(fd, "password"), again: text(fd, "again"),
    programName: text(fd, "programName"), timezone: text(fd, "timezone"), start: text(fd, "start") === "empty" ? "empty" : "demo",
  });
  if (!r.ok) return { error: r.error, at: Date.now() };
  await startSession(r.user);
  redirect("/intervals?notice=" + encodeURIComponent("This site is set up and you are its administrator."));
}

// ───────────────────────────── who has access (administrators only) ─────────────────────────────
async function linkFor(s: { programId: string; userId: string }, userId: string): Promise<LinkResult> {
  const m = await db.membership.findFirst({ where: { userId, programId: s.programId }, include: { user: true } });
  if (!m) return { ok: false, error: "That person does not have access to this program." };
  if (m.user.disabledAt) return { ok: false, error: "Their sign-in is switched off. Switch it back on first." };
  const made = await createAccessLink(userId, s.userId);
  await record(s, userId, made.purpose === "INVITE" ? "invite-link" : "reset-link");
  return { ok: true, link: `${await siteOrigin()}/join/${made.token}`, purpose: made.purpose, expires: made.expiresAt.toISOString(), email: m.user.email };
}

/** A new one-time link for someone who already has access: an invitation if they have no password yet, otherwise a reset. */
export async function makeLink(userId: string): Promise<LinkResult> {
  const s = await requireOwner();
  const r = await linkFor(s, userId);
  revalidatePath("/access");
  return r;
}

/** Give a participant a sign-in (as a resident, linked to their own schedule) and make their invitation link. */
export async function inviteParticipant(participantId: string): Promise<LinkResult> {
  const s = await requireOwner();
  const p = await db.participant.findFirst({ where: { id: participantId, programId: s.programId } });
  if (!p) return { ok: false, error: "That participant does not exist." };
  if (!p.email) return { ok: false, error: "Add an email address for this participant first." };
  const g = await grantAccess(s.programId, { name: `${p.firstName} ${p.lastName}`, email: p.email, access: "RESIDENT", participantId });
  if (!g.ok) return g;
  const r = await linkFor(s, g.userId);
  revalidatePath("/access");
  return r;
}

/** Give access to someone who is not a participant (a coordinator or program director, for example). */
export async function addPerson(name: string, email: string, access: "ADMIN" | "CHIEF"): Promise<LinkResult> {
  const s = await requireOwner();
  if (access !== "ADMIN" && access !== "CHIEF") return { ok: false, error: "Choose administrator or chief." };
  const g = await grantAccess(s.programId, { name, email, access });
  if (!g.ok) return g;
  await record(s, g.userId, "grant-access", { access });
  const r = await linkFor(s, g.userId);
  revalidatePath("/access");
  return r;
}

export async function changeLevel(membershipId: string, access: "ADMIN" | "CHIEF" | "RESIDENT"): Promise<Done> {
  const s = await requireOwner();
  if (!["ADMIN", "CHIEF", "RESIDENT"].includes(access)) return { ok: false, error: "Unknown access level." };
  const r = await setAccessLevel(s.programId, membershipId, access, s.userId);
  if (r.ok) await record(s, r.userId, "set-access", { access });
  revalidatePath("/", "layout");
  return r.ok ? { ok: true } : r;
}

export async function toggleSignIn(userId: string, enabled: boolean): Promise<Done> {
  const s = await requireOwner();
  const r = await setSignInEnabled(s.programId, userId, enabled, s.userId);
  if (r.ok) await record(s, userId, enabled ? "enable-sign-in" : "disable-sign-in");
  revalidatePath("/access");
  return r.ok ? { ok: true } : r;
}

export async function removePerson(membershipId: string): Promise<Done> {
  const s = await requireOwner();
  const m = await db.membership.findFirst({ where: { id: membershipId, programId: s.programId }, include: { user: true } });
  const r = await removeAccess(s.programId, membershipId, s.userId);
  if (r.ok) await db.auditLog.create({ data: { programId: s.programId, userId: s.userId, entity: "User", entityId: r.userId, action: "remove-access", changes: { email: m?.user.email } } });
  revalidatePath("/access");
  return r.ok ? { ok: true } : r;
}

/** Start over: wipe everything in the program and put back an empty one. Asks for the program's name, typed out. */
export async function startOver(_prev: FormMsg, fd: FormData): Promise<FormMsg> {
  const s = await requireOwner();
  const program = await db.program.findUniqueOrThrow({ where: { id: s.programId } });
  if (text(fd, "confirm").trim() !== program.name) return { error: `To confirm, type the program's name exactly: ${program.name}`, at: Date.now() };
  const active = await db.schedule.count({ where: { interval: { programId: s.programId }, runStatus: { in: ["QUEUED", "RUNNING"] } } });
  if (active) return { error: "A schedule is being generated. Wait for it to finish, or cancel it, then try again.", at: Date.now() };
  await wipeProgram(s.programId);
  const name = text(fd, "newName").trim();
  if (name) await db.program.update({ where: { id: s.programId }, data: { name } });
  await db.auditLog.create({ data: { programId: s.programId, userId: s.userId, entity: "Program", entityId: s.programId, action: "start-over", changes: { was: program.name } } });
  revalidatePath("/", "layout");
  redirect("/settings?notice=" + encodeURIComponent("Everything was removed. This is now an empty program with the standard rules."));
}

export async function signOutEverywhere() {
  const s = await getSession();
  if (s) await db.user.update({ where: { id: s.userId }, data: { sessionVersion: { increment: 1 } } });
  await endSession();
  redirect("/login");
}
