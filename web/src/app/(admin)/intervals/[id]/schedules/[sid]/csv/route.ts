// A schedule as a spreadsheet file: one line per person per shift, open shifts included.
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { DOW, dow, ymd } from "@/lib/util";

const cell = (v: unknown) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const hm = (d: Date) => d.toISOString().slice(11, 16);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const s = await requireAdmin();
  const { id, sid } = await params;
  const sch = await db.schedule.findFirst({ where: { id: sid, intervalId: id, interval: { programId: s.programId } }, include: { interval: true } });
  if (!sch) return new Response("Not found", { status: 404 });
  const rows = await db.scheduledShift.findMany({
    where: { scheduleId: sid }, include: { participant: { include: { role: true } }, institution: true, category: true },
    orderBy: [{ startsAt: "asc" }, { name: "asc" }],
  });
  const lines = [["Date", "Day", "Shift", "Type", "Institution", "Category", "Start", "End", "Hours", "Participant", "Role"].join(",")];
  for (const r of rows) {
    const day = new Date(ymd(r.startsAt) + "T00:00:00Z");
    lines.push([ymd(r.startsAt), DOW[dow(day)], r.name, r.backup ? "Backup (on call)" : "Shift", r.institution.name, r.category.name, hm(r.startsAt), hm(r.endsAt),
      r.backup ? 0 : (r.endsAt.getTime() - r.startsAt.getTime()) / 3600000, r.participant ? `${r.participant.lastName}, ${r.participant.firstName}` : "OPEN", r.participant?.role.name ?? ""].map(cell).join(","));
  }
  const name = `${sch.interval.name}_${sch.label ?? "schedule"}`.replace(/[^\w-]+/g, "_");
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
}
