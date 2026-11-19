// Generate -> review -> publish, in a real browser, with the real engine.
//   npm run db:reset && node e2e/schedule.cjs      (app running on BASE; takes about four minutes: it runs the engine three times)
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
  p.on("console", (m) => { if (m.type() === "error") errors.push("console at " + p.url() + ": " + m.text().slice(0, 300)); });
  const go = async (path) => { const r = await p.goto(BASE + path); await p.waitForLoadState("networkidle"); return r; };
  const text = () => p.locator("body").innerText();
  const signIn = (name) => require("./sign-in.cjs").signIn(p, BASE, name);
  const submit = async (button) => {
    const answered = p.waitForResponse((r) => r.request().method() === "POST", { timeout: 30000 }).catch(() => null);
    await button.click(); await answered; await p.waitForLoadState("networkidle"); await p.waitForTimeout(300);
  };
  // click a button whose action answers by sending the browser to a page with a message; wait until that page is showing
  const flash = async (button) => {
    const before = p.url();
    await button.click();
    await p.waitForFunction((u) => location.href !== u && /[?&](notice|error)=/.test(location.search), before, { timeout: 30000 });
    await p.waitForLoadState("networkidle"); await p.waitForTimeout(250);
  };
  const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const HUB = "/intervals/iv_7", TAB = HUB + "?tab=schedule";
  const januaryShifts = async () => (await p.locator("section", { hasText: "Published shifts" }).locator("tbody tr", { hasText: /Jan ([4-9]|[12]\d|3[01]), 2027/ }).count());   // Block 7 is 4-31 Jan
  const generate = async (budget = "quick") => {
    await go(TAB);
    await p.locator('select[name="budget"]').selectOption(budget);
    await p.getByTestId("generate-card").getByRole("button", { name: "Generate schedule" }).click();
    await p.waitForSelector('[data-testid="run-progress"]', { timeout: 30000 });
  };
  const waitForReview = async () => { await p.waitForURL(/\/schedules\/[^/?]+$/, { timeout: 200000 }); await p.waitForLoadState("networkidle"); return p.url().replace(BASE, ""); };

  // ── before anything is generated ─────────────────────────────────────────
  await signIn("Dr. Adams");
  ok((await januaryShifts()) === 0, "before publishing, a resident sees no Block 7 shifts");
  await signIn("Pat Coordinator");
  await go(HUB);
  ok(await p.getByRole("link", { name: "Generate schedule" }).isVisible(), "the interval page has a Generate schedule button");
  await p.getByRole("link", { name: "Generate schedule" }).click(); await p.waitForURL(/tab=schedule/); await p.waitForLoadState("networkidle");
  const card = await p.getByTestId("generate-card").innerText();
  ok(/fills 265 shifts over 28 days for 18 participants/.test(card), "the generate panel says what will be scheduled (265 shifts, 28 days, 18 people)");
  ok(/1 time-off request\(s\) are still pending and are NOT included/.test(await p.getByTestId("generate-warnings").innerText()), "it warns that a pending request will not be included");
  ok(/No schedule yet/.test(await p.getByTestId("schedules-table").innerText()), "no schedules are listed yet");
  await shot("schedule-generate");

  // ── start, watch, cancel ─────────────────────────────────────────────────
  await generate("standard");
  await p.waitForFunction(() => /first schedule|swaps|Working on|Checking|Reading/.test(document.querySelector('[data-testid="run-progress"]')?.textContent ?? ""), null, { timeout: 30000 });
  const runCard = await p.getByTestId("run-card").innerText();
  ok(/Generating Run 1/.test(runCard) && /of up to about 5:00/.test(runCard), "a run shows what the engine is doing and the time allowed");
  ok((await p.getByTestId("generate-card").count()) === 0 && await p.getByRole("link", { name: "Generating…" }).isVisible(), "while it runs, a second run cannot be started");
  await shot("schedule-running");
  await go(HUB + "?tab=coverage");
  ok(await p.getByRole("link", { name: "Generating…" }).isVisible(), "the run carries on while you look at other tabs");
  await go(TAB);
  await flash(p.getByRole("button", { name: "Cancel run" }));
  ok(/The run was cancelled\. Nothing was saved\./.test(await text()), "a run can be cancelled");
  const cancelledRow = await p.getByTestId("schedules-table").locator("tbody tr", { hasText: "Run 1" }).innerText();
  ok(/Cancelled/.test(cancelledRow) && !/filled/.test(cancelledRow), "the cancelled run is listed as cancelled, with no shifts");
  ok((await p.getByTestId("generate-card").count()) === 1, "after cancelling, a new run can be started");

  // ── a full run, then the review screen ───────────────────────────────────
  await generate("quick");
  const review = await waitForReview();
  ok(/\/intervals\/iv_7\/schedules\//.test(review), "when the engine finishes, the result opens for review by itself");
  ok((await p.getByTestId("schedule-status").innerText()) === "Draft", "a new schedule is a draft");
  const summary = await p.getByTestId("summary").innerText();
  const [, filled, total] = /Shifts filled\s+(\d+)\s+of (\d+)/.exec(summary) ?? [];
  const open = Number(await p.getByTestId("open-count").innerText());
  ok(total === "265" && Number(filled) + open === 265, `the summary accounts for all 265 shifts (${filled} filled, ${open} open)`);
  ok((await p.getByTestId("rule-check").innerText()) === "None broken", "the independent rule check reports no hard rule broken");
  ok(open === 0, "nothing is left open on the demo block");
  const grid = p.getByTestId("people-grid");
  ok((await grid.locator("tbody tr[data-person]").count()) === 18 && (await grid.locator("thead th").count()) === 32, "by-person grid: 18 people, 28 days, plus a Backup column");
  ok((await grid.locator("td[data-shift]").count()) === Number(filled), `by-person grid shows every filled shift once (${filled})`);
  const brooks = await grid.locator('tr[data-person="p02"]').innerText();
  ok((brooks.match(/VAC/g) ?? []).length === 7 && (await grid.locator('tr[data-person="p02"] td[title="Vacation"][data-shift]').count()) === 0, "a vacation week shows as VAC with no shift on it (Brooks, 11-17 Jan)");
  const perPerson = await grid.locator("tbody tr[data-person]").evaluateAll((rows) => rows.map((r) => ({ shown: r.querySelectorAll("td[data-shift]").length, cell: r.children[1].textContent.trim() })));
  ok(perPerson.every((x) => { const m = /^(\d+) \/(\d+)(?:–(\d+))?$/.exec(x.cell); return m && +m[1] === x.shown && x.shown >= +m[2] && x.shown <= +(m[3] ?? m[2]); }), "every person's shift count matches their row and is inside their contract range");
  ok((await p.getByTestId("legend").locator("span.rounded").count()) >= 13, "the legend explains every shift code");
  const adamsJan = await grid.locator('tr[data-person="p01"] td[data-shift]').count();
  await shot("schedule-review-people");
  await p.getByRole("tab", { name: "By shift" }).click(); await p.waitForURL(/view=shifts/); await p.waitForLoadState("networkidle");
  const sgrid = p.getByTestId("shift-grid");
  ok((await sgrid.locator("tbody td div.whitespace-nowrap").count()) === Number(filled) && (await sgrid.getByText("Open", { exact: true }).count()) === open, "by-shift grid shows the same shifts, by name");
  ok(/Night GP 21:00–07:00/.test(await sgrid.innerText()) && /LBJ Hospital/.test(await sgrid.innerText()), "shifts are grouped by institution with their times");
  await shot("schedule-review-shifts");
  await p.getByRole("tab", { name: /Goals & checks/ }).click(); await p.waitForURL(/view=details/); await p.waitForLoadState("networkidle");
  ok((await p.getByTestId("goals-table").locator("tbody tr").count()) === 12, "goals are listed in priority order (12)");
  ok(/Every shift filled\s+Fully met/.test(await p.getByTestId("goals-table").innerText()), "the first goal, every shift filled, is met");
  ok((await p.getByTestId("people-table").locator("tbody tr").count()) === 18, "per-person figures for all 18");
  ok(/shares no code with the part that builds the schedule/.test(await p.getByTestId("checks").innerText()), "the page says how the schedule was checked");
  await shot("schedule-review-details");

  // calendar: one box per date with every shift and who works it; all institutions, or one at a time
  await p.getByRole("tab", { name: "Calendar" }).click(); await p.waitForURL(/view=calendar/); await p.waitForLoadState("networkidle");
  const cal = p.getByTestId("calendar");
  ok((await cal.locator("td[data-date]").count()) === 28 && (await cal.getAttribute("data-scope")) === "all", "the calendar has a box for each of the 28 days (4 whole weeks, Monday to Sunday)");
  const named = async () => cal.locator("li [data-person]").count();
  const all = await named(), openAll = await cal.locator("[data-open]").count();
  ok(all === 265 + 28 && openAll === 0, `every filled shift and backup day appears once, with the person's name (${all} names)`);
  const jan4 = await cal.locator('td[data-date="2027-01-04"]').innerText();
  ok(/Day T/.test(jan4) && /Night GP/.test(jan4) && /LBJ/.test(jan4) && /MHH/.test(jan4), "4 Jan lists both hospitals' shifts, each marked with its institution");
  const perSite = {};
  for (const code of ["LBJ", "MHH"]) {
    await go(await p.getByRole("tab", { name: `${code} only` }).getAttribute("href"));
    const sites = await cal.locator("li[data-site]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-site")))]);
    perSite[code] = await named();
    ok(sites.length === 1 && sites[0] === code && perSite[code] > 0, `the ${code} view shows only ${code} shifts (${perSite[code]} names)`);
  }
  ok(perSite.LBJ + perSite.MHH === all, "the two hospital views add up to the combined one");
  await shot("schedule-review-calendar");
  const printed = await ctx.newPage();
  await printed.goto(BASE + (await p.getByTestId("print-each").getAttribute("href"))); await printed.waitForLoadState("networkidle");
  const titles = await printed.getByTestId("print-view").locator("h1").allInnerTexts();
  ok(titles.length === 3 && /All institutions \(LBJ \+ MHH\)/.test(titles[0]) && /LBJ only/.test(titles[1]) && /MHH only/.test(titles[2]), `the printable page has all three views, each on its own page (${titles.length})`);
  await printed.close();
  const csv = await (await ctx.request.get(BASE + review + "/csv")).text();
  const lines = csv.trim().split("\r\n");
  ok(lines.length === 1 + 265 + 28 && /^Date,Day,Shift,Type,Institution/.test(csv) && lines.filter((l) => /,Backup/.test(l)).length === 28, "the spreadsheet download has one line per shift plus one per backup day (265 + 28 + header)");

  // ── who may see it ───────────────────────────────────────────────────────
  await signIn("Dr. Adams");
  ok((await januaryShifts()) === 0, "a draft is not shown to residents");
  await p.goto(BASE + review); await p.waitForLoadState("networkidle");
  ok(p.url().endsWith("/me"), "a resident cannot open the review screen");
  ok((await ctx.request.get(BASE + review + "/status")).status() === 401, "nor ask about engine runs");
  await signIn("Pat Coordinator");

  // ── inputs change after generating: the schedule is flagged, publishing needs a deliberate tick ──
  await go(HUB + "?tab=requests");
  await submit(p.locator("tbody tr", { hasText: "Chen" }).getByRole("button", { name: "Approve" }));
  await go(review);
  ok(await p.getByTestId("stale-notice").isVisible(), "after a request is approved, the schedule is flagged as built on old inputs");
  await flash(p.getByTestId("publish-card").getByRole("button", { name: "Publish schedule" }));
  ok(/Not published: the inputs have changed since it was generated\. Tick the box/.test(await text()) && (await p.getByTestId("schedule-status").innerText()) === "Draft", "publishing it without the tick is refused");
  await p.getByTestId("publish-card").getByRole("checkbox").check();
  await flash(p.getByTestId("publish-card").getByRole("button", { name: "Publish schedule" }));
  ok((await p.getByTestId("schedule-status").innerText()) === "Published" && /Block 7 is published/.test(await text()), "with the tick, it publishes");
  ok((await p.getByTestId("publish-card").count()) === 0 && await p.getByRole("button", { name: "Unpublish" }).isVisible() && (await p.getByRole("button", { name: "Discard" }).count()) === 0, "a published schedule can be unpublished but not discarded");
  await go(HUB);
  ok(/Published/.test(await p.locator("h1").innerText()), "the interval is marked published");

  // ── what residents get ───────────────────────────────────────────────────
  await signIn("Dr. Adams");
  ok((await januaryShifts()) === adamsJan, `the resident now sees their Block 7 shifts (${adamsJan}, the same number as their row in the grid)`);
  const feed = await p.getByTestId("feed-url").innerText();
  const ics = await (await ctx.request.get(feed)).text();
  const inJan = (ics.match(/DTSTART[^\r\n]*:202701(0[4-9]|[12]\d|3[01])T\d{6}\r\n[^]*?END:VEVENT/g) ?? []).filter((e) => !/CATEGORIES:Academic/.test(e)).length;
  ok(inJan === adamsJan, `their calendar link carries the same shifts (${inJan})`);
  await shot("schedule-resident");
  await signIn("Pat Coordinator");

  // ── generate again with the new inputs; publishing it replaces the first ──
  await generate("quick");
  const review2 = await waitForReview();
  ok(review2 !== review && (await p.getByTestId("stale-notice").count()) === 0, "a schedule generated after the change is up to date");
  ok(/It replaces Run 2 that is published now/.test(await p.getByTestId("publish-card").innerText()), "the publish panel says it will replace the published one");
  await flash(p.getByTestId("publish-card").getByRole("button", { name: "Publish schedule" }));
  ok((await p.getByTestId("schedule-status").innerText()) === "Published", "an up-to-date schedule with nothing open publishes without a tick");
  await go(TAB);
  const list = await p.getByTestId("schedules-table").innerText();
  ok(/Run 3[^]*?Published/.test(list) && /Run 2[^]*?Replaced/.test(list) && (list.match(/Published/g) ?? []).length === 1, "the list shows Run 3 published and Run 2 replaced; only one is published");
  await shot("schedule-list");

  // ── unpublish, discard ───────────────────────────────────────────────────
  await flash(p.getByRole("button", { name: "Unpublish" }));
  ok(/Unpublished/.test(await text()) && /Locked/.test(await p.locator("h1").innerText()), "unpublishing returns the interval to locked");
  await signIn("Dr. Adams");
  ok((await januaryShifts()) === 0, "after unpublishing, residents no longer see the schedule");
  await signIn("Pat Coordinator");
  await go(TAB);
  await flash(p.getByTestId("schedules-table").locator("tbody tr", { hasText: "Run 1" }).getByRole("button", { name: "Discard" }));
  ok(/Run 1 was discarded/.test(await text()) && !/Run 1/.test(await p.getByTestId("schedules-table").innerText()), "a schedule that is not published can be discarded");

  // ── inputs that cannot be staffed: open shifts are shown with reasons ────
  await go("/shifts/s_dg");
  await p.getByLabel("Min participants").fill("9"); await p.getByLabel("Max participants").fill("9");
  await submit(p.getByRole("button", { name: "Save", exact: true }));
  await generate("quick");
  const review3 = await waitForReview();
  const open3 = Number(await p.getByTestId("open-count").innerText());
  ok(open3 > 0 && (await p.getByTestId("rule-check").innerText()) === "None broken", `asking for 9 people on Day GP leaves shifts open (${open3}) but still breaks no hard rule`);
  ok(/cannot be fully staffed/.test(await text()), "the review says the inputs could not be fully staffed");
  await p.getByRole("tab", { name: /Goals & checks/ }).click(); await p.waitForURL(/view=details/); await p.waitForLoadState("networkidle");
  const openList = await p.getByTestId("open-list").innerText();
  ok(/Day GP/.test(openList) && /Why nobody else can take it:/.test(openList), "each open shift is listed with why nobody else can take it");
  await shot("schedule-open-shifts");
  await flash(p.getByTestId("publish-card").getByRole("button", { name: "Publish schedule" }));
  ok(new RegExp(`Not published: ${open3} shifts are still open`).test(await text()), "a schedule with open shifts is not published without the tick");
  ok(review3 !== review2, "each run is kept as its own schedule");

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) console.log("FAILED:\n  " + fails.join("\n  "));
  console.log(errors.length ? "BROWSER ERRORS:\n" + [...new Set(errors)].slice(0, 10).join("\n") : "no browser errors");
  await b.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
