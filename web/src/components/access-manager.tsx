"use client";
// The "Sign-in & access" screen: who can sign in, at what level, and the one-time links that let them choose a password.
// A link is shown once, right after it is made, for the administrator to send on; the server keeps only its fingerprint.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addPerson, changeLevel, inviteParticipant, makeLink, removePerson, toggleSignIn, type LinkResult } from "@/app/account-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge, Card, td, th } from "@/components/ui/misc";

export type Person = {
  membershipId: string; userId: string; name: string; email: string; access: "ADMIN" | "CHIEF" | "RESIDENT"; participant: string | null;
  hasPassword: boolean; disabled: boolean; lastLogin: string | null; linkExpires: string | null; isYou: boolean;
};
export type Waiting = { participantId: string; name: string; role: string; email: string | null };
type Shown = { link: string; purpose: "INVITE" | "RESET"; expires: string; email: string; name: string };

const LEVEL = { ADMIN: "Administrator", CHIEF: "Chief", RESIDENT: "Resident" } as const;

export function AccessManager({ people, waiting, timezone }: { people: Person[]; waiting: Waiting[]; timezone: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  const run = (name: string, job: () => Promise<LinkResult | { ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null); setCopied(false);
      const r = await job();
      if (!r.ok) setError(r.error);
      else if ("link" in r) setShown({ ...r, name });
      router.refresh();
    });

  const copy = async () => { try { await navigator.clipboard.writeText(shown!.link); setCopied(true); } catch { setCopied(false); } };

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="access-error">{error}</p>}
      {shown && (
        <Card className="border-brand/40 bg-brand-soft/40 p-4" data-testid="link-card">
          <p className="text-sm font-medium">{shown.purpose === "INVITE" ? "Invitation" : "Password reset"} link for {shown.name} ({shown.email})</p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={shown.link} aria-label="One-time link" data-testid="link-value" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button type="button" variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Send this to them yourself, by email or text. It is shown only now: it works once, until {when(shown.expires)}, and lets them choose {shown.purpose === "INVITE" ? "a" : "a new"} password.
            Anyone who has the link can use it, so send it only to them. If it is lost, make another; the old one stops working.
          </p>
          <button type="button" className="mt-2 text-xs text-brand hover:underline" onClick={() => setShown(null)}>Done</button>
        </Card>
      )}

      <section>
        <h2 className="mb-2 text-base font-semibold">People with access</h2>
        <Card className="overflow-x-auto">
          <table className="w-full" data-testid="people-with-access">
            <thead className="border-b border-line bg-surface"><tr>{["Person", "Access", "Sign-in", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {people.map((p) => (
                <tr key={p.membershipId} data-email={p.email}>
                  <td className={td}>
                    <span className="font-medium">{p.name}</span>{p.isYou && <Badge tone="blue" className="ml-2">You</Badge>}
                    <div className="text-xs text-muted">{p.email}{p.participant ? ` · sees ${p.participant}'s schedule` : ""}</div>
                  </td>
                  <td className={td}>
                    <Select aria-label={`Access level for ${p.name}`} value={p.access} disabled={busy} className="w-40"
                      onChange={(e) => run(p.name, () => changeLevel(p.membershipId, e.target.value as Person["access"]))}>
                      {Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </td>
                  <td className={td}>
                    {p.disabled ? <Badge tone="red">Switched off</Badge>
                      : p.hasPassword ? <><Badge tone="green">Active</Badge><div className="mt-0.5 text-xs text-muted">{p.lastLogin ? `Last signed in ${when(p.lastLogin)}` : "Has not signed in yet"}</div></>
                      : p.linkExpires ? <><Badge tone="amber">Invited</Badge><div className="mt-0.5 text-xs text-muted">Link works until {when(p.linkExpires)}</div></>
                      : <Badge tone="gray">No password yet</Badge>}
                    {p.hasPassword && !p.disabled && p.linkExpires && <div className="mt-0.5 text-xs text-muted">Reset link works until {when(p.linkExpires)}</div>}
                  </td>
                  <td className={td + " whitespace-nowrap text-right"}>
                    <span className="inline-flex items-center gap-3">
                      {!p.disabled && <button type="button" disabled={busy} className="text-xs text-brand hover:underline" onClick={() => run(p.name, () => makeLink(p.userId))}>{p.hasPassword ? "Make reset link" : p.linkExpires ? "Make new invite link" : "Make invite link"}</button>}
                      {!p.isYou && <button type="button" disabled={busy} className="text-xs text-ink/70 hover:underline" onClick={() => run(p.name, () => toggleSignIn(p.userId, p.disabled))}>{p.disabled ? "Switch sign-in on" : "Switch sign-in off"}</button>}
                      {!p.isYou && <button type="button" disabled={busy} className="text-xs text-red-700 hover:underline"
                        onClick={() => { if (window.confirm(`Remove ${p.name}'s access altogether? They will no longer be able to sign in. Their participant record and schedule are not affected.`)) run(p.name, () => removePerson(p.membershipId)); }}>Remove</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 max-w-3xl text-xs text-muted">
          Administrators can do everything, including this screen. Chiefs can edit the program&apos;s setup, rules and schedules but cannot change who has access.
          Residents see only their own page. Switching sign-in off signs the person out at once and can be undone.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Participants without a sign-in</h2>
        {waiting.length === 0 ? <p className="text-sm text-muted">Every active participant has a sign-in.</p> : (
          <Card className="overflow-x-auto">
            <table className="w-full" data-testid="participants-waiting">
              <thead className="border-b border-line bg-surface"><tr>{["Participant", "Email", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {waiting.map((w) => (
                  <tr key={w.participantId}>
                    <td className={td}><span className="font-medium">{w.name}</span><div className="text-xs text-muted">{w.role}</div></td>
                    <td className={td}>{w.email ?? <span className="text-muted">No email on record</span>}</td>
                    <td className={td + " text-right"}>
                      {w.email
                        ? <button type="button" disabled={busy} className="text-xs text-brand hover:underline" onClick={() => run(w.name, () => inviteParticipant(w.participantId))}>Give a sign-in and make invite link</button>
                        : <span className="text-xs text-muted">Add an email under Participants first</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Add an administrator or chief who is not a participant</h2>
        <Card className="max-w-3xl p-4">
          <form className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_11rem_auto]" data-testid="add-person"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget), form = e.currentTarget;
              run(String(f.get("name")), async () => { const r = await addPerson(String(f.get("name")), String(f.get("email")), f.get("access") as "ADMIN" | "CHIEF"); if (r.ok) form.reset(); return r; });
            }}>
            <div><Label htmlFor="new-name">Name</Label><Input id="new-name" name="name" required /></div>
            <div><Label htmlFor="new-email">Email</Label><Input id="new-email" name="email" type="email" required /></div>
            <div><Label htmlFor="new-access">Access</Label><Select id="new-access" name="access" defaultValue="ADMIN"><option value="ADMIN">Administrator</option><option value="CHIEF">Chief</option></Select></div>
            <Button disabled={busy}>Add and make invite link</Button>
          </form>
        </Card>
      </section>
    </div>
  );
}
