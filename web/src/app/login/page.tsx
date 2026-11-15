import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { setupNeeded } from "@/lib/program-setup";
import { SignInForm } from "@/components/auth-forms";
import { Card } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function Login() {
  const s = await getSession();
  if (s) redirect(s.access === "RESIDENT" ? "/me" : "/intervals");
  if (await setupNeeded()) redirect("/setup");
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-brand-dark">Cadence</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your program&apos;s schedule.</p>
      <Card className="mt-6 p-5"><SignInForm /></Card>
      <p className="mt-4 text-xs text-muted">
        Forgotten your password, or never had one? Ask your program&apos;s administrator for a sign-in link.
        Access is by invitation only.
      </p>
    </main>
  );
}
