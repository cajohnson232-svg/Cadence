// The per-participant assignment pages, academic-day exceptions, backup shifts, special staffing days,
// shifts entered for the previous interval, and Optimize. Real browser, real engine, demo database.
//   npm run db:reset && node e2e/assignments.cjs        (app running on BASE, default http://localhost:3000)
// Takes about 3 minutes: it generates one quick schedule and optimizes it once.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3000";
const SHOTS = process.env.SHOTS || "/tmp/shots";
require("fs").mkdirSync(SHOTS, { recursive: true });
let pass = 0; const fails = [];
const ok = (cond, what) => { if (cond) { pass++; console.log("ok   " + what); } else { fails.push(what); console.log("FAIL " + what); } };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push(`console at ${p.url()}: ` + m.text().slice(0, 300)); });
  const go = async (path) => { await p.goto(BASE + path); await p.waitForLoadState("networkidle"); };
  const text = () => p.locator("body").innerText();
  const signIn = (name) => require("./sign-in.cjs").signIn(p, BASE, name);
  // a server-action form: click and wait for the redirect it answers with (?notice= or ?error=)
  const flash = async (button) => {
    const before = p.url();
    await button.click();
    await p.waitForFunction((u) => location.href !== u && /[?&](notice|error)=/.test(location.search), before, { timeout: 30000 });
    await p.waitForLoadState("networkidle"); await p.waitForTimeout(200);
    return decodeURIComponent((p.url().match(/[?&](?:notice|error)=([^&#]*)/) || [])[1] || "").replace(/\+/g, " ");
  };
  const isError = () => /[?&]error=/.test(p.url());
  const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const waitForReview = async () => { await p.waitForURL(/\/schedules\/[^/?]+$/, { timeout: 240000 }); await p.waitForLoadState("networkidle"); return p.url().replace(BASE, ""); };
  const rules = async (iv) => { await go(`/intervals/${iv}?tab=rules`); return p.getByTestId("compiled-rules").innerText(); };

  await signIn("Pat Coordinator");

  // ── generate a quick schedule first (the edits below change the inputs), check backup, then optimize it ──
  await go("/intervals/iv_7?tab=schedule");
  await p.getByTestId("generate-card").locator('select[name="budget"]').selectOption("quick");
  await p.getByTestId("generate-card").getByRole("button", { name: "Generate schedule" }).click();
  const run1 = await waitForReview();
  ok((await p.locator("[data-backup]").count()) >= 25, `the review grid marks backup days (BU): ${await p.locator("[data-backup]").count()} of 28`);
  ok(/Backup days covered\s*\d+\s*of 28/.test(await p.getByTestId("backup-tile").innerText()), "a tile counts backup days covered out of 28");
  await shot("review-backup");
  await go(run1 + "?view=details");
  ok(/Backup \(on call\)/.test(await p.getByTestId("backup-section").innerText()), "the details view explains backup");
  await go(run1);
  ok(/Backup days are chosen again/.test(await p.getByTestId("optimize-card").innerText()), "the Optimize card says backup is chosen again for the new schedule");
  await p.getByTestId("optimize-card").locator('select[name="budget"]').selectOption("quick");
  await p.getByTestId("optimize-card").getByRole("button", { name: "Optimize" }).click();
  await p.waitForURL(/tab=schedule/, { timeout: 30000 });
  ok(/Generating Run 2/.test(await p.getByTestId("run-card").innerText()), "optimizing starts a new run on the interval page");
  const run2 = await waitForReview();
  ok(run2 !== run1 && /Run 2 \(optimized from Run 1\)/.test(await text()), "the result is a new draft, labelled Run 2 (optimized from Run 1)");
  await go("/intervals/iv_7?tab=schedule");
  ok(/Run 1[\s\S]*Draft/.test(await p.getByTestId("schedules-table").innerText()), "the schedule it started from is still listed as a draft");

  // ── participant list: filter by role, sort by name ──────────────────────
  await go("/assignments");
  const rows = p.getByTestId("assignment-people").locator("tbody tr");
  ok((await rows.count()) === 18, "the Assignments tab lists every participant (18)");
  ok((await rows.first().innerText()).startsWith("Adams, Avery"), "sorted by last name by default");
  await p.getByLabel("Role").selectOption({ label: "PGY-3" }); await p.getByRole("button", { name: "Show" }).click(); await p.waitForURL(/role=role_pgy3/); await p.waitForLoadState("networkidle");
  ok((await rows.count()) === 5 && (await p.getByTestId("assignment-people").innerText()).includes("Nguyen, Morgan") && !(await p.getByTestId("assignment-people").innerText()).includes("Adams"), "filtering by role leaves only that role (5 PGY-3s)");
  await go("/assignments?sort=first");
  ok((await rows.first().innerText()).startsWith("Avery Adams") && (await rows.nth(1).innerText()).startsWith("Blake Brooks"), "sorting by first name shows First Last");
  await go("/assignments?q=stone");
  ok((await rows.count()) === 1 && /Stone, Riley[\s\S]*Off-service rotator[\s\S]*Assigned/.test(await rows.first().innerText()), "search finds a person and shows the intervals they are assigned to");
  await shot("assignments-list");

  // ── assign and remove (Block 6 has no assignments) ──────────────────────
  await go("/assignments/p01?interval=iv_6");
  ok(await p.getByTestId("not-assigned").isVisible(), "a participant not in an interval is offered 'Assign to'");
  ok(/is assigned to Block 6/.test(await flash(p.getByRole("button", { name: "Assign to Block 6" }))), "assigning saves");
  ok(/16.18/.test(await p.getByTestId("shift-count").innerText()) && /PGY-1 default/.test(await p.getByTestId("shift-count").innerText()), "shift counts come from the role (PGY-1: 16-18), not from the assignment");
  await flash(p.getByRole("button", { name: "Remove from Block 6" }));
  ok(await p.getByTestId("not-assigned").isVisible(), "removing from the interval works");

  // ── institutions: split percentages and date windows ───────────────────
  const BR = "/assignments/p02?interval=iv_7";
  await go(BR);
  const inst = p.getByTestId("institutions-form");
  for (const n of ["Memorial Hermann Hospital", "LBJ Hospital"]) if (!(await inst.getByLabel(n, { exact: true }).isChecked())) await inst.getByLabel(n, { exact: true }).check();
  await inst.getByLabel("Percent at Memorial Hermann Hospital").fill("70"); await inst.getByLabel("Percent at LBJ Hospital").fill("20");
  ok(/Total: 90% \(must add up to 100%\)/.test(await p.getByTestId("pct-sum").innerText()), "the form adds the percentages up as you type");
  let msg = await flash(inst.getByRole("button", { name: "Save institutions" }));
  ok(isError() && /add up to 90%/.test(msg), "percentages that do not add up to 100% are refused");
  await inst.getByLabel("Percent at Memorial Hermann Hospital").fill("70"); await inst.getByLabel("Percent at LBJ Hospital").fill("30");
  await inst.getByLabel("Only from, LBJ Hospital").evaluate((e) => { e.removeAttribute("min"); e.removeAttribute("max"); });
  await inst.getByLabel("Only from, LBJ Hospital").fill("2027-02-10");
  msg = await flash(inst.getByRole("button", { name: "Save institutions" }));
  ok(isError() && /must be inside Block 7/.test(msg), "an institution date outside the interval is refused");
  await inst.getByLabel("Percent at Memorial Hermann Hospital").fill("70"); await inst.getByLabel("Percent at LBJ Hospital").fill("30");
  await inst.getByLabel("Only from, LBJ Hospital").fill("2027-01-18");
  msg = await flash(inst.getByRole("button", { name: "Save institutions" }));
  ok(!isError() && (await inst.getByLabel("Percent at LBJ Hospital").inputValue()) === "30" && (await inst.getByLabel("Only from, LBJ Hospital").inputValue()) === "2027-01-18", "a 70/30 split with LBJ only from 18 Jan saves");

  // ── adjustments ─────────────────────────────────────────────────────────
  await p.locator("#delta").fill("0");
  msg = await flash(p.getByRole("button", { name: "Add adjustment" }));
  ok(isError() && /whole number of shifts/.test(msg), "an adjustment of 0 is refused");
  await p.locator("#delta").fill("2"); await p.locator("#reason").fill("Covering a colleague's leave");
  await flash(p.getByRole("button", { name: "Add adjustment" }));
  ok(/\+2[\s\S]*Covering a colleague's leave/.test(await p.getByTestId("adjustment-list").innerText()), "an extra-shifts adjustment saves with its reason");
  ok(/− 2 adjustment = 14.16/.test(await p.getByTestId("shift-count").innerText()), "the summary adds up the role's 16-18 and both adjustments (-4 + 2 = 14-16)");
  await p.locator("#delta").fill("-1");
  await flash(p.getByRole("button", { name: "Add adjustment" }));
  ok(!isError() && (await p.getByTestId("adjustment-list").locator("tr").count()) === 3, "a reduction saves without a reason (the reason is optional)");
  await flash(p.getByRole("button", { name: "Remove adjustment -1" }));
  ok((await p.getByTestId("adjustment-list").locator("tr").count()) === 2, "an adjustment can be removed");

  // ── required time off ──────────────────────────────────────────────────
  await p.locator("#off-from").fill("2027-01-22"); await p.locator('input[name="wholeDay"]').uncheck();
  msg = await flash(p.getByRole("button", { name: "Add", exact: true }));
  ok(isError() && /start and end time/.test(msg), "time off that is not a whole day needs a start and end time");
  await p.locator("#off-from").fill("2027-01-22"); await p.locator('input[name="wholeDay"]').uncheck();
  await p.locator("#off-start").fill("08:00"); await p.locator("#off-end").fill("12:00"); await p.locator("#off-reason").fill("Court date");
  await flash(p.getByRole("button", { name: "Add", exact: true }));
  ok(/Jan 22[\s\S]*08:00[\s\S]*12:00[\s\S]*Court date/.test(await p.getByTestId("required-off-list").innerText()), "required time off with a time window saves");

  // ── no nights and notes ────────────────────────────────────────────────
  await p.locator('input[name="noNights"]').check(); await p.locator("#notes").fill("No nights during religious observance; agreed with the program director.");
  await flash(p.locator("#preferences").getByRole("button", { name: "Save" }));
  await go(BR);
  ok((await p.locator('input[name="noNights"]').isChecked()) && /religious observance/.test(await p.locator("#notes").inputValue()), "no nights and the notes are saved");

  // ── personal academic day ──────────────────────────────────────────────
  await p.locator("#pa-name").fill("QI project"); await p.locator("#pa-day").selectOption({ label: "Tue" }); await p.locator("#pa-start").fill("13:00"); await p.locator("#pa-hours").fill("3");
  await p.locator("#pa-skip").fill("19 Jan");
  msg = await flash(p.getByRole("button", { name: "Add personal academic day" }));
  ok(isError() && /YYYY-MM-DD/.test(msg), "dates it does not happen must be written as dates");
  await p.locator("#pa-name").fill("QI project"); await p.locator("#pa-day").selectOption({ label: "Tue" }); await p.locator("#pa-start").fill("13:00"); await p.locator("#pa-hours").fill("3");
  await p.locator("#pa-skip").fill("2027-01-19");
  ok((await p.getByLabel("If a shift overlaps this session, the individual cannot work it").isChecked()), "the overlap question is a yes/no box, ticked by default");
  await flash(p.getByRole("button", { name: "Add personal academic day" }));
  ok(/QI project[\s\S]*Tue/.test(await p.getByTestId("personal-academic-list").innerText()), "a personal academic day saves");
  await shot("assignment-participant");

  const r7 = await rules("iv_7");
  ok(/Brooks[\s\S]*Split between institutions: 70% MHH, 30% LBJ/.test(r7) || /Split between institutions: 70% MHH, 30% LBJ/.test(r7), "compiled rules: Brooks's 70/30 split");
  ok(/14-16 shifts at [^\n]*\(adjusted -2: Vacation week; Covering a colleague's leave\)/.test(r7), "compiled rules: the adjusted shift count (14-16) with both reasons");
  ok(/No night shifts/.test(r7) && /Off 2027-01-22 to 2027-01-22, 08:00-12:00 \(Court date\)/.test(r7), "compiled rules: no nights and the 08:00-12:00 time off");
  ok(/QI project: 3 session\(s\) in the interval; overlapping shifts are blocked/.test(r7), "compiled rules: the personal academic day (4 Tuesdays less the one that does not happen)");

  // ── program academic day: a date it does not happen ────────────────────
  await go("/academic-days/ac_conf");
  ok(await p.getByLabel("If a shift overlaps this session, the individual cannot work it").isVisible(), "a program academic day asks the overlap question as yes/no");
  const before = (await rules("iv_7")).match(/Wednesday conference: (\d+) session/)?.[1];
  await go("/academic-days/ac_conf");
  await p.locator("#skip-date").fill("2027-01-06");
  await flash(p.getByRole("button", { name: "Add date" }));
  ok(/Jan 6, 2027/.test(await p.getByTestId("skip-dates").innerText()), "an isolated date it does not happen saves (6 Jan)");
  const after = (await rules("iv_7")).match(/Wednesday conference: (\d+) session/)?.[1];
  ok(before && after && Number(after) === Number(before) - 1, `the interval has one session fewer (${before} -> ${after})`);

  // ── an inactive shift, then special staffing days ──────────────────────
  await go("/shifts/new");
  await p.getByLabel("Name").fill("Holiday surge"); await p.getByLabel("Institution").selectOption({ label: "MHH · Memorial Hermann Hospital" });
  const area = await p.getByLabel("Area").locator("option").evaluateAll((os) => os.map((o) => o.textContent).find((t) => t.startsWith("MHH")));
  await p.getByLabel("Area").selectOption({ label: area }); await p.getByLabel("Category").selectOption({ label: "Day" });
  await p.getByLabel("Start time").fill("10:00"); await p.getByLabel("Length (hours)").fill("8"); await p.getByLabel("Active").uncheck();
  await p.getByRole("button", { name: "Save", exact: true }).click(); await p.waitForURL(/\/shifts(\?|$)/); await p.waitForLoadState("networkidle");

  await go("/special-days/new");
  const sd = p.getByTestId("special-day-form");
  await sd.getByLabel("Institution").selectOption({ label: "Memorial Hermann Hospital" }); await sd.getByLabel("Date").fill("2027-01-25"); await sd.getByLabel("Name").fill("Ice storm");
  await sd.getByLabel(/^Replace/).check();
  ok(/Holiday surge\s*Inactive/.test(await p.getByTestId("replace-list").innerText()), "Replace lists every shift at the institution, inactive ones too");
  ok((await sd.getByLabel("Run Fast track").isChecked()) && !(await sd.getByLabel("Run Holiday surge").isChecked()), "Replace starts with the shifts that normally run that day ticked");
  const ticked = p.getByTestId("replace-list").locator('input[type="checkbox"]:checked');
  while (await ticked.count()) await ticked.first().uncheck();
  await sd.getByRole("button", { name: "Save special staffing day" }).click();
  await p.waitForSelector('[role="alert"]');
  ok(/tick at least one|choose at least one|at least one shift/i.test(await sd.getByRole("alert").innerText()), "Replace with nothing ticked is refused");
  await sd.getByLabel("Run Day T", { exact: true }).check(); await sd.getByLabel("Run Holiday surge").check(); await sd.getByLabel("People on Holiday surge").fill("2");
  await sd.getByRole("button", { name: "Save special staffing day" }).click();
  await p.waitForURL(/\/special-days\/[^/?]+\?notice=/); await p.waitForLoadState("networkidle");
  ok((await sd.getByLabel("Run Holiday surge").isChecked()) && (await sd.getByLabel("People on Holiday surge").inputValue()) === "2" && !(await sd.getByLabel("Run Fast track").isChecked()), "a Replace day saves only the ticked shifts, with a per-day headcount");
  await shot("special-day-replace");

  await go("/special-days/new");
  await sd.getByLabel("Institution").selectOption({ label: "Memorial Hermann Hospital" }); await sd.getByLabel("Date").fill("2027-01-26"); await sd.getByLabel("Name").fill("Snow day");
  await sd.getByLabel(/^Modify/).check();
  await sd.getByLabel("Describe the changes").fill("No Fast track. Day M starts at 9 and lasts 6 hours.");
  await sd.getByRole("button", { name: "Read the changes" }).click();
  await p.waitForSelector('[data-testid="reading"]', { timeout: 60000 });
  const lines = p.getByTestId("modify-lines").locator("tbody tr");
  const read = [];
  for (let i = 0; i < (await lines.count()); i++) read.push(`${await sd.getByLabel(`Change ${i + 1}`).inputValue()} ${await sd.getByLabel(`Shift ${i + 1}`).inputValue()}`);
  ok(read.includes("REMOVE s_ft") && read.includes("CHANGE s_dm"), `the text is read into editable lines (${read.join(", ")})`);
  const dm = read.indexOf("CHANGE s_dm") + 1;
  ok((await sd.getByLabel(`Start ${dm}`).inputValue()) === "09:00" && (await sd.getByLabel(`Hours ${dm}`).inputValue()) === "6", "Day M: starts 09:00, 6 hours");
  await sd.getByRole("button", { name: "Save special staffing day" }).click();
  await p.waitForURL(/\/special-days\/[^/?]+\?notice=/); await p.waitForLoadState("networkidle");
  ok((await sd.getByLabel("Describe the changes").inputValue()).includes("No Fast track") && (await lines.count()) === read.length, "a Modify day saves its text and its lines");
  await shot("special-day-modify");
  const r7b = await rules("iv_7");
  ok(/Ice storm: only the listed shifts run \(2 line\(s\)\)/.test(r7b) && /Snow day: normal shifts with changes \(2 line\(s\)\)/.test(r7b), "compiled rules include both new special days");

  // ── backup shift rules ─────────────────────────────────────────────────
  await go("/shifts/s_bk");
  const bk = p.getByTestId("backup-rules");
  await bk.getByLabel("The rules, in your own words").fill("PGY-3 only. No more than 2 backup days each, at least 5 days apart.");
  await bk.getByRole("button", { name: "Turn into rules" }).click();
  await p.waitForSelector('[data-testid="backup-reading"]', { timeout: 60000 });
  ok((await bk.getByLabel("Most backup days per person").inputValue()) === "2" && (await bk.getByLabel("Days between one person's backups").inputValue()) === "5", "the words are read into rules (at most 2 each, 5 days apart)");
  const roles = p.getByTestId("backup-roles");
  ok((await roles.getByLabel("PGY-3").isChecked()) && !(await roles.getByLabel("PGY-2").isChecked()) && !(await roles.getByLabel("PGY-1").isChecked()), "who can take backup is read too (PGY-3 only)");
  await bk.getByRole("button", { name: "Save backup rules" }).click();
  await p.waitForFunction(() => /saved/i.test(document.querySelector('[data-testid="backup-rules"] [role="alert"]')?.textContent ?? ""), null, { timeout: 20000 });
  await go("/shifts/s_bk");
  ok(/at most 2[\s\S]*5 days[\s\S]*PGY-3 can take it/.test(await p.getByTestId("backup-summary").innerText()) && !/PGY-2/.test(await p.getByTestId("backup-summary").innerText()), "after saving, the rules and the role grid say PGY-3 only, at most 2, 5 days apart");
  ok(/Backup every day, 07:00 for 24h, 1 person: .*at most 2.*; 5 eligible/.test(await rules("iv_7")), "compiled rules carry the backup line with 5 eligible (the PGY-3s)");

  // ── how the previous interval ended (Block 6 has nothing published before it) ──
  await go("/intervals/iv_6?tab=schedule");
  const pc = p.getByTestId("prior-card");
  ok(await pc.isVisible(), "with no published schedule before it, the interval asks how the previous one ended");
  await pc.locator('select[name="participantId"]').selectOption({ label: "Nguyen, Morgan" }); await pc.locator('input[name="date"]').fill("2026-12-06");
  await pc.locator('select[name="shiftId"]').selectOption("s_nt");
  await flash(pc.getByRole("button", { name: "Add", exact: true }));
  ok(/Nguyen, Morgan[\s\S]*Night T/.test(await p.getByTestId("prior-list").innerText()), "a shift from the week before can be entered");
  await p.getByText("Paste from a spreadsheet").click();
  await p.getByLabel("Pasted shifts").fill("Adams, 2026-12-05, Day T\nNobody, 2026-12-05, Day T");
  msg = await flash(p.getByRole("button", { name: "Add these" }));
  ok(isError() && /Nothing was added[\s\S]*nobody called "Nobody"/.test(msg), "a paste with a bad line adds nothing and says which line");
  await p.getByText("Paste from a spreadsheet").click();
  await p.getByLabel("Pasted shifts").fill("Adams, 2026-12-05, Day T\nHarper Kim\t2026-12-06\tEvening M");
  msg = await flash(p.getByRole("button", { name: "Add these" }));
  ok(/2 shifts added/.test(msg) && (await p.getByTestId("prior-list").locator("tr").count()) === 3, "pasted lines (comma or tab separated) are added");
  for (const pid of ["p01", "p13"]) { await go(`/assignments/${pid}?interval=iv_6`); await flash(p.getByRole("button", { name: "Assign to Block 6" })); }
  ok(/Previous interval[\s\S]*2 shift\(s\) entered by hand/.test(await rules("iv_6")), "the compiled rules use the entered shifts of people in the interval as history (Adams, Nguyen)");
  ok(/1 shift\(s\) entered for the previous interval belong to people not assigned/.test(await text()), "and warn about the one for someone not in the interval (Kim)");

  await shot("end");
  if (errors.length) { console.log("BROWSER ERRORS:\n" + errors.slice(0, 8).join("\n")); }
  console.log(`\n${pass} passed, ${fails.length} failed${errors.length ? `, ${errors.length} browser error(s)` : ""}`);
  await b.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.log("CRASHED: " + e.message.split("\n").slice(0, 4).join("\n")); process.exit(1); });
