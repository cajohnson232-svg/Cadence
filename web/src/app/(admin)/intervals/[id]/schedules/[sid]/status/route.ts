// What an engine run is doing right now. Asking also finishes the run's import if the engine is done,
// so the page that polls this is what moves a run from "running" to "ready to review".
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { runProgress, settleRun } from "@/lib/engine";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const s = await getSession();
  if (!s || s.access === "RESIDENT") return Response.json({ error: "Not signed in as an administrator." }, { status: 401 });
  const { id, sid } = await params;
  const where = { id: sid, intervalId: id, interval: { programId: s.programId } };
  if (!(await db.schedule.findFirst({ where, select: { id: true } }))) return Response.json({ error: "Not found." }, { status: 404 });
  await settleRun(sid);
  const sch = await db.schedule.findFirst({ where });
  if (!sch) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json(runProgress(sch), { headers: { "cache-control": "no-store" } });
}
