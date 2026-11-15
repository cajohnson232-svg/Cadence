// Your own account: who you are signed in as, and changing your password.
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { signOutEverywhere } from "@/app/account-actions";
import { ChangePasswordForm } from "@/components/auth-forms";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/misc";
import { fmtWhen } from "@/lib/schedule-view";

export default async function Account() {
  const s = await requireSession();
  const [user, program] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: s.userId } }), db.program.findUniqueOrThrow({ where: { id: s.programId } })]);
  const level = s.access === "ADMIN" ? "Administrator" : s.access === "CHIEF" ? "Chief" : "Resident";
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Link href={s.access === "RESIDENT" ? "/me" : "/intervals"} className="text-sm text-brand hover:underline">← Back</Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Your account</h1>
      <p className="mt-1 text-sm text-muted">{s.userName} · {s.email} · {level} at {s.programName}</p>
      <Card className="mt-6 p-5">
        <h2 className="mb-3 text-base font-semibold">Change password</h2>
        <ChangePasswordForm email={s.email} />
        {user.passwordSetAt && <p className="mt-3 text-xs text-muted">Last changed {fmtWhen(user.passwordSetAt, program.timezone)}.</p>}
      </Card>
      <Card className="mt-5 p-5">
        <h2 className="text-base font-semibold">Signed in somewhere you no longer use?</h2>
        <p className="mt-1 text-sm text-muted">This signs you out on every device, including this one. Your password stays the same.</p>
        <form action={signOutEverywhere} className="mt-3"><Button variant="outline">Sign out everywhere</Button></form>
      </Card>
    </main>
  );
}
