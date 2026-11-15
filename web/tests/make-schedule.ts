// Start an engine run for an interval from the command line, or wait for one to be imported.
//   npx tsx tests/make-schedule.ts start iv_7 [seconds] [polish]     -> prints the schedule id and exits (the engine keeps running)
//   npx tsx tests/make-schedule.ts wait <schedule id>                -> waits until it is imported, prints its status
import "dotenv/config";
import { db } from "../src/lib/db";
import { settleRun, startRun } from "../src/lib/engine";

async function main() {
  const [cmd, id, seconds = "12", polish = "6"] = process.argv.slice(2);
  if (cmd === "start") {
    const r = await startRun(id, null, { seconds: Number(seconds), polish: Number(polish) });
    if (!r.ok) throw new Error(r.error);
    console.log(r.scheduleId);
  } else if (cmd === "wait") {
    let st: string | null = "RUNNING";
    for (let i = 0; i < 600 && (st === "RUNNING" || st === "QUEUED"); i++) { st = await settleRun(id); if (st === "RUNNING" || st === "QUEUED") await new Promise((r) => setTimeout(r, 500)); }
    console.log(st);
  } else throw new Error("usage: start <interval id> [seconds] [polish] | wait <schedule id>");
  await db.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
