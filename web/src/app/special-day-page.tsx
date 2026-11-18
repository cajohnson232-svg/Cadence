// Shared by the new and edit pages of a special staffing day.
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { aiLabel } from "@/lib/ai";
import { SpecialDayForm } from "@/components/special-day-form";
import { Flash } from "@/components/entity-pages";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/misc";
import { deleteSpecialDay, type DayPayload } from "@/app/special-day-actions";

export async function SpecialDayPage({ id, sp, initial, title }: { id: string | null; sp: Record<string, string | undefined>; initial: DayPayload; title: string }) {
  const s = await requireAdmin();
  const [institutions, categories, shifts] = await Promise.all([
    db.institution.findMany({ where: { programId: s.programId, archivedAt: null }, orderBy: { name: "asc" } }),
    db.shiftCategory.findMany({ where: { programId: s.programId }, orderBy: { sortOrder: "asc" } }),
    db.shift.findMany({ where: { programId: s.programId, archivedAt: null, isBackup: false }, orderBy: [{ startMinute: "asc" }, { name: "asc" }] }),
  ]);
  return (
    <>
      <Link href="/special-days" className="text-sm text-brand hover:underline">← Special staffing days</Link>
      <PageHeader title={title} description="One date at one institution where staffing differs from usual: a holiday, a conference, an event." />
      <Flash sp={sp} />
      <Card className="p-5">
        <SpecialDayForm id={id} initial={initial} aiLabel={aiLabel()}
          institutions={institutions.map((i) => ({ id: i.id, name: i.name }))} categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          shifts={shifts.map((x) => ({ id: x.id, institutionId: x.institutionId, name: x.name, startMinute: x.startMinute, durationMinutes: x.durationMinutes, minParticipants: x.minParticipants, categoryId: x.categoryId, daysOfWeek: x.daysOfWeek, active: x.active }))} />
      </Card>
      {id && <form action={deleteSpecialDay.bind(null, id)} className="mt-4"><Button variant="outline" size="sm">Delete this special staffing day</Button></form>}
    </>
  );
}
