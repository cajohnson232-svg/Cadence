import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { SpecialDayPage } from "@/app/special-day-page";
import { ymd } from "@/lib/util";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireAdmin();
  const { id } = await params;
  const d = await db.specialStaffingDay.findFirst({ where: { id, programId: s.programId }, include: { shifts: { orderBy: { id: "asc" } } } });
  if (!d) notFound();
  return <SpecialDayPage id={id} sp={await searchParams} title={d.name}
    initial={{ institutionId: d.institutionId, date: ymd(d.date), name: d.name, mode: d.mode, changeText: d.changeText ?? "",
      lines: d.shifts.map((l) => ({ action: l.action, shiftId: l.shiftId, name: l.name, categoryId: l.categoryId, startMinute: l.startMinute, durationMinutes: l.durationMinutes, minParticipants: l.minParticipants })) }} />;
}
