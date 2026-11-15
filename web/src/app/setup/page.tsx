// First-time setup of a new site: the first administrator and their program.
// Open only while nobody is able to sign in; after that it sends people to the sign-in page.
import { redirect } from "next/navigation";
import { setupNeeded } from "@/lib/program-setup";
import { TIMEZONES } from "@/lib/domain";
import { SetupForm } from "@/components/auth-forms";
import { Card } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function Setup() {
  if (!(await setupNeeded())) redirect("/login");
  const keyRequired = process.env.NODE_ENV === "production" || !!process.env.SETUP_KEY;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-brand-dark">Set up Cadence</h1>
      <p className="mt-1 text-sm text-muted">This creates the first administrator, which is you. It can only be done once; after that, people join by invitation.</p>
      <Card className="mt-6 p-5"><SetupForm timezones={TIMEZONES} keyRequired={keyRequired} /></Card>
    </main>
  );
}
