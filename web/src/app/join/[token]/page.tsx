// Where a one-time link lands: an invitation (choose your first password) or a reset (choose a new one).
// Opening the page does not use the link up; only saving a password does.
import Link from "next/link";
import { readAccessLink } from "@/lib/accounts";
import { JoinForm } from "@/components/auth-forms";
import { Card } from "@/components/ui/misc";

export const dynamic = "force-dynamic";
export const metadata = { referrer: "no-referrer" as const };

export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await readAccessLink(token);
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-brand-dark">Cadence</h1>
      {!link ? (
        <>
          <p className="mt-6 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">This link has expired or has already been used. Ask your program&apos;s administrator for a new one.</p>
          <p className="mt-4 text-sm"><Link href="/login" className="text-brand hover:underline">Go to sign in</Link></p>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            {link.purpose === "RESET" ? "Choose a new password for " : `${link.user.memberships[0].program.name} has invited you. Choose a password for `}
            <strong className="text-ink">{link.user.email}</strong>.
          </p>
          <Card className="mt-6 p-5"><JoinForm token={token} email={link.user.email} reset={link.purpose === "RESET"} /></Card>
          <p className="mt-4 text-xs text-muted">This link works once. After this you sign in with your email and the password you choose.</p>
        </>
      )}
    </main>
  );
}
