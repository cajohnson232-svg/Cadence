// Uploading "how the previous interval ended" from a spreadsheet: every layout it should read, on the demo program.
//   1. Cadence's own Excel download of Block 7, read for a block starting Feb 1: exactly the shifts of Jan 25–31,
//      from the "By person" sheet (codes + key) and from the "By shift" sheet (last names) on their own
//   2. a program-style grid: real Excel dates, "First Last" names, full shift names, Off/VAC cells; an unknown
//      rotation and an unknown person are listed, not guessed
//   3. headers that are only "Mon 25": the month comes from the block that follows
//   4. a .csv list with m/d/yyyy dates and the columns in any order
//   5. a file with nothing in the 7 days: nothing found, and the dates it does cover are reported
//   npx tsx tests/prior-import-check.ts      (needs the demo database; runs Block 7 once if it has no engine schedule)
import "dotenv/config";
import ExcelJS from "exceljs";
import { db } from "../src/lib/db";
import { settleRun, startRun } from "../src/lib/engine";
import { scheduleWorkbook } from "../src/lib/schedule-xlsx";
import { importPrior, readGrids, readSheet } from "../src/lib/prior-import";
import { addDays, parseYmd, ymd } from "../src/lib/util";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, what: string) => { if (c) { pass++; console.log("ok   " + what); } else { fails.push(what); console.log("FAIL " + what); } };

(async () => {
  let sch = await db.schedule.findFirst({ where: { intervalId: "iv_7", runStatus: "DONE", source: "SOLVER" } });
  if (!sch) {
    const a = await startRun("iv_7", null, { seconds: 20, polish: 5 });
    if (!a.ok) throw new Error(a.error);
    for (let i = 0; i < 600; i++) { const st = await settleRun(a.scheduleId); if (st !== "RUNNING" && st !== "QUEUED") break; await new Promise((r) => setTimeout(r, 500)); }
    sch = await db.schedule.findUniqueOrThrow({ where: { id: a.scheduleId } });
  }
  const iv = await db.interval.findUniqueOrThrow({ where: { id: "iv_7" } });
  const people = await db.participant.findMany({ where: { programId: iv.programId, archivedAt: null }, select: { id: true, firstName: true, lastName: true, email: true } });
  const shifts = await db.shift.findMany({ where: { programId: iv.programId, archivedAt: null, isBackup: false }, include: { institution: true } });
  const next = parseYmd("2027-02-01"), w = { from: addDays(next, -7), to: addDays(next, -1) };
  const truth = (await db.scheduledShift.findMany({ where: { scheduleId: sch.id, backup: false, participantId: { not: null }, dutyDate: { gte: w.from, lte: w.to } } }))
    .map((r) => `${r.participantId}|${ymd(r.dutyDate)}|${r.shiftId}`).sort();
  const keys = (f: { participantId: string; date: Date; shiftId: string }[]) => [...new Set(f.map((x) => `${x.participantId}|${ymd(x.date)}|${x.shiftId}`))].sort();

  // 1. Cadence's own export
  const out = (await scheduleWorkbook(sch.id, iv.programId))!;
  const best = (await importPrior(out.buffer, out.filename, people, shifts, w, next))!;
  ok(truth.length > 30 && JSON.stringify(keys(best.found)) === JSON.stringify(truth) && best.problems.length === 0,
    `Cadence's download: all ${truth.length} shifts of Jan 25–31 read from "${best.sheet}" (${best.layout}), nothing unreadable, ${best.outside} on other dates left out`);
  const grids = await readGrids(out.buffer, out.filename);
  const byShift = readSheet(grids.find((g) => g.name === "By shift")!, people, shifts, w, next);
  ok(JSON.stringify(keys(byShift.found)) === JSON.stringify(truth) && byShift.problems.length === 0, `its "By shift" sheet alone gives the same ${truth.length} (${byShift.layout})`);

  // 2. a program-style grid
  const P = (last: string) => people.find((p) => p.lastName === last)!;
  const S = (name: string) => shifts.find((s) => s.name === name)!;
  const [a, b, c] = [P("Adams"), P("Brooks"), P("Chen")];
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Block 7");
  ws.addRow(["Emergency Medicine Block 7"]);
  ws.addRow(["Resident", ...Array.from({ length: 10 }, (_, i) => addDays(parseYmd("2027-01-22"), i))]);
  ws.addRow([`${a.firstName} ${a.lastName}`, "Day T", "", "", "Off", "Night T", "Night T", "VAC", "", "Evening M", ""]);
  ws.addRow([`${b.firstName} ${b.lastName}`, "", "", "", "ICU", "", S("Day M").name, "", "", "", "Day T"]);
  ws.addRow(["Visiting Student", "", "", "", "Day T", "", "", "", "", "", ""]);
  ws.addRow([`${c.lastName}, ${c.firstName}`, "", "", "", "", "", "", "", "", "Swing CC", ""]);
  const buf2 = Buffer.from(await wb.xlsx.writeBuffer());
  const r2 = (await importPrior(buf2, "program.xlsx", people, shifts, w, next))!;
  const want2 = [`${a.id}|2027-01-26|${S("Night T").id}`, `${a.id}|2027-01-27|${S("Night T").id}`, `${a.id}|2027-01-30|${S("Evening M").id}`,
    `${b.id}|2027-01-27|${S("Day M").id}`, `${b.id}|2027-01-31|${S("Day T").id}`, `${c.id}|2027-01-30|${S("Swing CC").id}`].sort();
  ok(JSON.stringify(keys(r2.found)) === JSON.stringify(want2), `a program grid (Excel dates, full names, Off/VAC): the 6 shifts in Jan 25–31 (${r2.found.length}); Jan 22 left out (${r2.outside})`);
  ok(r2.problems.some((x) => /"ICU": not a shift here/.test(x)) && r2.problems.some((x) => /"Visiting Student": nobody by that name/.test(x)) && r2.problems.length === 2,
    `what it can't read is listed: ${r2.problems.join("; ")}`);

  // 3. day numbers only
  const wb3 = new ExcelJS.Workbook(), ws3 = wb3.addWorksheet("Sheet1");
  ws3.addRow(["Name", "Mon 25", "Tue 26", "Wed 27", "Thu 28", "Fri 29", "Sat 30", "Sun 31"]);
  ws3.addRow([a.lastName, "Day T", "Day T", "", "", "", "", "Night T"]);
  const r3 = (await importPrior(Buffer.from(await wb3.xlsx.writeBuffer()), "days.xlsx", people, shifts, w, next))!;
  ok(JSON.stringify(keys(r3.found)) === JSON.stringify([`${a.id}|2027-01-25|${S("Day T").id}`, `${a.id}|2027-01-26|${S("Day T").id}`, `${a.id}|2027-01-31|${S("Night T").id}`].sort()),
    `"Mon 25 … Sun 31" headers are placed in the week before the block (${r3.found.map((x) => ymd(x.date)).join(", ")})`);

  // 4. a csv list, columns in any order
  const csv = `Shift,Resident,Date\nDay T,${a.lastName},1/29/2027\n"Night T","${b.lastName}, ${b.firstName}",1/30/2027\nDay T,${a.lastName},1/10/2027\n`;
  const r4 = (await importPrior(Buffer.from(csv), "list.csv", people, shifts, w, next))!;
  ok(r4.layout === "one shift per row" && JSON.stringify(keys(r4.found)) === JSON.stringify([`${a.id}|2027-01-29|${S("Day T").id}`, `${b.id}|2027-01-30|${S("Night T").id}`].sort()) && r4.outside === 1,
    "a .csv list (shift, name, m/d/yyyy in any order) is read; a date outside the week is left out");

  // 5. the wrong block
  const early = { from: parseYmd("2027-01-01"), to: parseYmd("2027-01-07") };
  const wb5 = new ExcelJS.Workbook(), ws5 = wb5.addWorksheet("x");
  ws5.addRow(["Name", parseYmd("2027-03-01"), parseYmd("2027-03-02"), parseYmd("2027-03-03")]);
  ws5.addRow([a.lastName, "Day T", "", "Night T"]);
  const r5 = (await importPrior(Buffer.from(await wb5.xlsx.writeBuffer()), "march.xlsx", people, shifts, early, parseYmd("2027-01-08")))!;
  ok(r5.found.length === 0 && !!r5.fileDates && ymd(r5.fileDates[0]) === "2027-03-01", "a file for other dates finds nothing in the week, and says which dates it has");

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
