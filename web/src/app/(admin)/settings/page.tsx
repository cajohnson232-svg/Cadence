import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { TIMEZONES } from "@/lib/domain";
import { saveSettings } from "@/app/actions";
import { Flash } from "@/components/entity-pages";
import { StartOverForm } from "@/components/start-over-form";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/misc";

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const p = await db.program.findUniqueOrThrow({ where: { id: s.programId } });
  return (
    <>
      <PageHeader title="Program settings" description="Defaults for the whole program. Each interval can set its own allowances and open or close requests." />
      <Flash sp={await searchParams} />
      <Card className="max-w-2xl p-5">
        <form action={saveSettings} className="space-y-4">
          <div><Label htmlFor="name">Program name</Label><Input id="name" name="name" defaultValue={p.name} required /></div>
          <div><Label htmlFor="timezone">Default timezone</Label>
            <Select id="timezone" name="timezone" defaultValue={p.timezone}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><Label htmlFor="days">Request days allowed per participant per interval</Label><Input id="days" name="defaultRequestAllowance" type="number" min={0} defaultValue={p.defaultRequestAllowance} />
              <p className="mt-1 text-xs text-muted">Counted per day requested</p></div>
            <div><Label htmlFor="high">Of which high priority</Label><Input id="high" name="defaultHighPriorityAllowance" type="number" min={0} defaultValue={p.defaultHighPriorityAllowance} /></div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="requestsRequireApproval" defaultChecked={p.requestsRequireApproval} className="mt-0.5 size-4 accent-[var(--color-brand)]" />
            <span>Requests off need approval before they count<span className="block text-xs text-muted">On: a resident&apos;s request waits as pending until an admin or chief approves it. Off: it counts as soon as it is submitted within the allowance.</span></span>
          </label>
          <Button>Save settings</Button>
        </form>
      </Card>
      {s.access === "ADMIN" && (
        <Card className="mt-8 max-w-2xl border-red-200 p-5">
          <h2 className="text-base font-semibold text-red-800">Start over with an empty program</h2>
          <p className="mt-1 text-sm text-muted">
            Removes everything in {p.name}: institutions, roles, participants, shifts, intervals, assignments, time off, rules, schedules and history.
            Administrators keep their sign-in; everyone else&apos;s access is removed. The standard rules, shift categories and PGY roles are put back.
            Use this to clear the demo program before entering your own. <strong>It cannot be undone.</strong>
          </p>
          <StartOverForm programName={p.name} />
        </Card>
      )}
    </>
  );
}
