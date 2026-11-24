// A schedule as an Excel workbook: By person, By shift, Calendar, and Goals & checks (one sheet each).
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { scheduleWorkbook } from "@/lib/schedule-xlsx";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const s = await requireAdmin();
  const { id, sid } = await params;
  if (!(await db.schedule.findFirst({ where: { id: sid, intervalId: id, interval: { programId: s.programId } } }))) return new Response("Not found", { status: 404 });
  const out = await scheduleWorkbook(sid, s.programId);
  if (!out) return new Response("This schedule has not finished, so there is nothing to export.", { status: 404 });
  return new Response(new Uint8Array(out.buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${out.filename}"`,
    },
  });
}
