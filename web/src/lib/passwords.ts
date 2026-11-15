// Passwords: how they are stored, checked, and what is accepted as a new one.
//
// A password is never stored. What is stored is the result of scrypt (a deliberately slow, memory-hard
// function) over the password and a random salt, with its settings alongside so they can be raised later:
//     scrypt$<N>$<r>$<p>$<salt>$<key>
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768, R = 8, P = 3, KEY_BYTES = 64;      // one of the parameter sets OWASP lists for scrypt

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((ok, bad) => scrypt(password.normalize("NFKC"), salt, len, { N: n, r, p, maxmem: 256 * n * r }, (e, key) => (e ? bad(e) : ok(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_BYTES);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

// Checking a password for an account that does not exist still does the slow work, against this value,
// so that the time taken does not reveal which email addresses have accounts.
const DECOY = ["scrypt", N, R, P, Buffer.alloc(16, 7).toString("base64"), Buffer.alloc(KEY_BYTES, 9).toString("base64")].join("$");

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [kind, n, r, p, salt, key] = (stored || DECOY).split("$");
  if (kind !== "scrypt" || !key) return false;
  const want = Buffer.from(key, "base64");
  let got: Buffer;
  try { got = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), want.length); } catch { return false; }
  return !!stored && got.length === want.length && timingSafeEqual(got, want);
}

import { MIN_PASSWORD } from "./password-rules";
export { MIN_PASSWORD };
const COMMON = new Set(["password12", "password123", "password1234", "1234567890", "12345678910", "0123456789", "qwertyuiop", "qwerty12345", "iloveyou123",
  "letmein1234", "welcome1234", "changeme123", "administrator", "aaaaaaaaaa", "1111111111", "0000000000", "abcdefghij", "abc1234567", "passwordpassword"]);

/** Why a new password is not acceptable, or null if it is. Length matters most; there are no symbol rules. */
export function passwordProblem(password: string, who: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A few words together work well.`;
  if (password.length > 200) return "That password is too long (200 characters at most).";
  const low = password.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(password)) return "That password is one of the most commonly used. Choose another.";
  const local = who.email?.split("@")[0]?.toLowerCase();
  if ((who.email && low === who.email.toLowerCase()) || (local && local.length >= 4 && low.includes(local))) return "Do not use your email address in your password.";
  if (who.name && who.name.trim().length >= 4 && low.replace(/\s+/g, "") === who.name.toLowerCase().replace(/\s+/g, "")) return "Do not use your name as your password.";
  return null;
}
