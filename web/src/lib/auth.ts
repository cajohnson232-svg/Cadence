// Who is signed in, and what they may see.
//
// A session is a signed cookie: user id, the account's session version, and when it was issued.
// It is refused if the signature is wrong, it is older than 30 days, the account has been switched
// off, or the session version has moved on (which happens when the password changes).
// Everything else in the app only uses getSession / requireSession / requireAdmin / requireOwner.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";

const COOKIE = "cadence_session";
const MAX_AGE = 30 * 24 * 3600;          // seconds

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length >= 32 && !/replace-with/i.test(s)) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is not set. Set it to a long random value (32 characters or more) before running in production.");
  return "development-only-secret-not-for-production";
}
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type Session = {
  userId: string;
  userName: string;
  email: string;
  programId: string;
  programName: string;
  access: "ADMIN" | "CHIEF" | "RESIDENT";
  participantId: string | null;
};

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, userId, version, issued, sig] = parts;
  if (!same(sig, sign(parts.slice(0, 4).join(".")))) return null;
  const age = Date.now() / 1000 - Number(issued);
  if (!(age >= -60 && age < MAX_AGE)) return null;
  const m = await db.membership.findFirst({ where: { userId, program: { archivedAt: null } }, include: { user: true, program: true }, orderBy: { id: "asc" } });
  if (!m || m.user.disabledAt || !m.user.passwordHash || String(m.user.sessionVersion) !== version) return null;
  return {
    userId, userName: m.user.name, email: m.user.email, programId: m.programId, programName: m.program.name,
    access: m.access, participantId: m.participantId,
  };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Admins and chiefs edit everything about the schedule; residents are sent to their own page. */
export async function requireAdmin(): Promise<Session> {
  const s = await requireSession();
  if (s.access === "RESIDENT") redirect("/me");
  return s;
}

/** Only administrators decide who can sign in and what they may do. Chiefs and residents are sent home. */
export async function requireOwner(): Promise<Session> {
  const s = await requireSession();
  if (s.access !== "ADMIN") redirect(s.access === "RESIDENT" ? "/me" : "/intervals");
  return s;
}

/** The address people use to reach this site, e.g. https://cadence.example.org */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  return `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

export async function startSession(user: { id: string; sessionVersion: number }) {
  const body = ["v1", user.id, user.sessionVersion, Math.floor(Date.now() / 1000)].join(".");
  const https = (await siteOrigin()).startsWith("https://");
  (await cookies()).set(COOKIE, `${body}.${sign(body)}`, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: MAX_AGE });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

/** The caller's network address as the hosting service reports it, for slowing down password guessing. */
export async function clientAddress(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || null;
}
