// The engine's input for an interval, as the JSON file the Python solver reads (python run.py <file>).
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { compileInterval } from "@/lib/compile";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireAdmin();
  const { id } = await params;
  if (!(await db.interval.findFirst({ where: { id, programId: s.programId } }))) return new Response("Not found", { status: 404 });
  const { config, interval } = await compileInterval(id);
  return new Response(JSON.stringify(config, null, 1), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${interval.name.replace(/[^\w-]+/g, "_")}_engine_input.json"` },
  });
}
