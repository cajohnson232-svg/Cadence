// End-to-end checks in a real browser against a freshly reset demo database.
//   npm run db:reset && node e2e/flows.cjs        (app running on BASE, default http://localhost:3000)
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
  p.on("console", (m) => { if (m.type() === "error") { errors.push("console: " + m.text().slice(0, 300)); if (process.env.DEBUG) console.log("  [browser error at " + p.url() + "]\n" + m.text().slice(0, 1800)); } });
  const go = (path) => p.goto(BASE + path);
  const text = () => p.locator("body").innerText();
  const signIn = (name) => require("./sign-in.cjs").signIn(p, BASE, name);
  // click a submit button and wait for the server action's response and whatever it re-renders
  const submit = async (button) => {
    const answered = p.waitForResponse((r) => r.request().method() === "POST", { timeout: 20000 }).catch(() => null);
    await button.click();
    await answered;
    await p.waitForLoadState("networkidle");
    await p.waitForTimeout(300);
  };
  const save = (label = "Save") => submit(p.getByRole("button", { name: label, exact: true }));
  const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

  // ── access ──────────────────────────────────────────────────────────────
  await go("/intervals"); ok(p.url().includes("/login"), "signed-out visitors are sent to sign-in");
  await signIn("Dr. Adams"); ok(p.url().endsWith("/me"), "a resident lands on their own page");
  await go("/participants"); ok(p.url().endsWith("/me"), "a resident cannot open admin screens");
  await signIn("Pat Coordinator"); ok(p.url().endsWith("/intervals"), "an admin lands on Intervals");

  // ── interval hub ────────────────────────────────────────────────────────
  await p.getByRole("link", { name: "Block 7" }).click(); await p.waitForURL(/intervals\/iv_7/);
  ok(await p.locator('[data-testid="coverage-grid"] tbody tr').count() >= 13, "coverage grid lists every shift");
  ok((await p.locator('[data-testid="coverage-grid"] thead th').count()) === 29, "coverage grid has one column per day (28)");
  const grid = await p.locator('[data-testid="coverage-grid"]').innerText();
  ok(/Shifts to fill/.test(grid) && /People not on leave/.test(grid), "coverage grid totals shifts and people per day");
  ok((await text()).includes("265 shifts to fill"), "coverage total matches the engine input (265 shifts)");
  await shot("hub-coverage");
  await go("/intervals/iv_7?tab=requests");
  ok((await p.locator('[data-testid="requests-table"]').innerText()).includes("3 of 4 days · 2 of 1 high (over)"), "requests tab counts allowance per day and flags over-use (Adams: 3 days used, 2 of them high priority)");
  ok((await text()).includes("1 waiting for a decision"), "requests tab shows how many are pending");
  await shot("hub-requests");
  await go("/intervals/iv_7?tab=adjustments");
  ok(/Nguyen[\s\S]*-2[\s\S]*Chief duties[\s\S]*12–14/.test(await p.locator('[data-testid="adjustments-table"]').innerText()), "adjustments tab shows the adjusted contract (Nguyen 12-14)");
  await go("/intervals/iv_7?tab=rules");
  const rules = await p.locator('[data-testid="compiled-rules"]').innerText();
  ok((await p.locator('[data-testid="compiled-rules"] tbody tr').count()) === 59, "compiled rules lists all 59 entries for Block 7");
  ok(rules.includes("Cannot work Night shifts at LBJ Hospital") && rules.includes("Stored only") && rules.includes("Needs review") && rules.includes("Not included (pending)"), "compiled rules marks enforced / stored only / needs review / not included");
  ok((await text()).includes("1 time-off request(s) are still pending"), "compiled rules warns about pending requests");
  await shot("hub-compiled-rules");
  await submit(p.getByRole("button", { name: "Close requests" }));
  ok((await text()).includes("Requests closed"), "an admin can close requests for an interval");

  // ── resident: requests off against the allowance ────────────────────────
  await signIn("Dr. Adams");
  ok(!(await p.getByRole("button", { name: "Submit request" }).count()), "resident cannot submit while requests are closed");
  await signIn("Pat Coordinator"); await go("/intervals/iv_7"); await submit(p.getByRole("button", { name: "Open requests" }));
  await signIn("Dr. Adams");
  await p.getByLabel("First day").fill("2027-01-14"); await p.getByLabel("Priority").selectOption("LOW"); await submit(p.getByRole("button", { name: "Submit request" }));
  ok((await text()).includes("It counts once it has been approved") && (await text()).includes("Used 4 of 4 days"), "resident submits a request: pending, and counted (3 -> 4 of 4 days)");
  await p.getByLabel("First day").fill("2027-01-20"); await submit(p.getByRole("button", { name: "Submit request" }));
  ok((await text()).includes("the allowance for Block 7 is 4"), "resident is stopped at the allowance");
  ok(/BEGIN:VCALENDAR/.test(await (await ctx.request.get(BASE + "/api/calendar/cal_p01")).text()), "calendar feed serves iCalendar");
  ok((await ctx.request.get(BASE + "/api/calendar/nope")).status() === 404, "calendar feed rejects an unknown token");
  await shot("resident");

  // ── admin approves / turns a request off ────────────────────────────────
  await signIn("Pat Coordinator"); await go("/requests?status=PENDING");
  ok((await p.locator("tbody tr").count()) === 2, "pending filter shows the two pending requests");
  await submit(p.locator("tbody tr", { hasText: "Adams" }).getByRole("button", { name: "Approve" }));
  await go("/requests?q=Adams"); ok((await p.locator("tbody tr", { hasText: "Jan 14" }).innerText()).includes("Approved"), "admin approves a request");
  await submit(p.locator("tbody tr", { hasText: "Jan 14" }).getByRole("button", { name: "Turn off" }));
  await go("/requests?q=Adams"); ok((await p.locator("tbody tr", { hasText: "Jan 14" }).innerText()).includes("Denied"), "admin turns an approved request back off");

  // ── form validation ─────────────────────────────────────────────────────
  // assignments are now per participant and per interval: covered by e2e/assignments.cjs

  await go("/shifts/new");
  await p.getByLabel("Start time").fill("22:30"); await p.getByLabel("Length (hours)").fill("9.5");
  ok((await p.locator('[data-testid="ends"]').innerText()).includes("Ends 08:00 the next day"), "shift form works out an end time across midnight as you type");
  await p.getByLabel("Name").fill("Late GP"); await p.getByLabel("Institution").selectOption({ label: "LBJ · LBJ Hospital" }); await p.getByLabel("Area").selectOption({ label: "MHH · Trauma" });
  await p.getByLabel("Category").selectOption({ label: "Night" }); await save();
  ok((await text()).includes("That area belongs to a different institution"), "a shift's area must belong to its institution");
  await p.getByLabel("Area").selectOption({ label: "LBJ · General" }); await save();
  await go("/shifts?q=Late"); ok((await text()).includes("22:30–08:00 (next day)") && (await text()).includes("9.5h"), "the overnight shift saved with its computed end and length");

  await go("/requests/new?intervalId=iv_7");
  await p.getByLabel("Participant").selectOption({ label: "Garcia, Gray (PGY-2)" }); await p.getByLabel("First day").fill("2027-01-18"); await p.getByLabel("Last day").fill("2027-01-22"); await save();
  ok((await text()).includes("This takes them to 6 of 4 request days"), "going over the allowance is flagged (counted per day)");
  await p.getByLabel("Save even if this goes over the allowance").check(); await save();
  await go("/requests?q=Garcia"); const g = await p.locator("tbody tr", { hasText: "Jan 18" }).innerText();
  ok(g.includes("(override)") && g.includes("special staffing day: MLK Day"), "admin override saves it, and the list shows the special staffing day it falls on");
  await go("/vacation"); ok((await text()).includes("Misses Wednesday conference Jan 13"), "vacation list shows the academic session it overlaps");

  await go("/intervals/new"); await p.getByLabel("Name").fill("Clash"); await p.getByLabel("Start date").fill("2027-01-25"); await p.getByLabel("End date").fill("2027-02-10"); await save();
  ok((await text()).includes("Overlaps Block 7"), "overlapping intervals are refused");

  // ── archive instead of delete ───────────────────────────────────────────
  await go("/roles"); await p.getByRole("link", { name: "PGY-1", exact: true }).click(); await p.waitForURL(/roles\//); await submit(p.getByRole("button", { name: "Delete" }));
  ok((await text()).includes("archived instead of deleted"), "a role that is in use is archived, not deleted");
  ok(!(await p.locator("tbody").innerText()).includes("PGY-1"), "archived rows leave the default list");
  await go("/roles?archived=1"); ok((await p.locator("tbody").innerText()).includes("PGY-1"), "...and come back with Show archived");
  await p.getByRole("link", { name: "PGY-1", exact: true }).click(); await p.waitForURL(/roles\//); await submit(p.getByRole("button", { name: "Restore" }));
  await go("/roles"); ok((await p.locator("tbody").innerText()).includes("PGY-1"), "restore brings it back");

  // ── rules ───────────────────────────────────────────────────────────────
  await go("/rules");
  ok((await p.locator('[data-testid="rules-table"] tbody tr').count()) === 24, "rules list shows all 24 rules, hard and soft together");
  await shot("rules-list");
  await go("/rules?engine=stored+only"); ok((await p.locator('[data-testid="rules-table"] tbody tr').count()) >= 2, "rules can be filtered by engine status");
  await go("/rules/new");
  await p.getByLabel("Rule template").selectOption({ label: "Max nights in a row" });
  await p.getByLabel("Number").fill("4"); await p.getByLabel("Applies to").selectOption("ROLE"); await p.getByLabel("Which role").selectOption({ label: "PGY-1" });
  ok((await p.locator('[data-testid="rule-sentence"]').innerText()).includes("No more than 4 night shifts in a row"), "rule form shows the rule in words as it is filled in");
  ok((await p.locator('[data-testid="engine-note"]').innerText()).includes("Stored only"), "rule form says when the engine does not enforce a template yet");
  await p.getByText("Soft: a goal, with a weight").click(); await p.getByLabel("Weight (1–10)").fill("12"); await save("Save rule");
  ok((await text()).includes("Weight is a whole number from 1 to 10"), "soft-rule weight is validated");
  await p.getByLabel("Weight (1–10)").fill("7"); await save("Save rule");
  ok(p.url().includes("/rules?notice") && (await text()).includes("No more than 4 night shifts in a row"), "a templated rule saves and appears in the list");
  await go("/rules/new"); await p.getByLabel("Rule template").selectOption({ label: "Cannot work (by date, weekday, time, shift type or site)" }); await save("Save rule");
  ok((await text()).includes("Say what they cannot work"), "an empty 'cannot work' rule is refused");

  // ── other restrictions (plain English) ──────────────────────────────────
  await go("/rules/assist");
  await p.getByLabel("Restriction, in plain English").fill("Dr. Patel can't work overnights at LBJ from Feb 3 to Mar 20");
  await submit(p.getByRole("button", { name: "Turn into a rule" })); await p.locator('[data-testid="proposal"]').waitFor();
  ok((await p.locator('[data-testid="original-text"]').innerText()).includes("Dr. Patel can't work overnights"), "original text is shown beside the proposal");
  ok((await p.locator('[data-testid="rule-sentence"]').innerText()).includes("Cannot work Night shifts at LBJ"), "plain English becomes a structured 'cannot work' rule");
  ok(await p.getByLabel("Active from").inputValue() === "2027-02-03" && await p.getByLabel("Active to").inputValue() === "2027-03-20", "dates in the text become the rule's active dates");
  ok((await p.getByLabel("Which participant").inputValue()) === "p15", "the person named is picked as the target (Patel)");
  await shot("assist-proposal");
  await go("/rules?q=Patel"); ok((await p.locator('[data-testid="rules-table"] tbody').innerText()).includes("Nothing matches"), "nothing is saved until the admin confirms");
  await go("/rules/assist");
  await p.getByLabel("Restriction, in plain English").fill("Dr. Patel can't work overnights at LBJ from Feb 3 to Mar 20");
  await submit(p.getByRole("button", { name: "Turn into a rule" })); await p.locator('[data-testid="proposal"]').waitFor();
  await p.getByLabel("Active to").fill("2027-03-27");                       // the admin edits a field before confirming
  await save("Confirm and save rule");
  await go("/rules?q=Patel"); const pr = await p.locator('[data-testid="rules-table"] tbody').innerText();
  ok(pr.includes("AI-assisted") && pr.includes("Dr. Patel can't work overnights at LBJ from Feb 3 to Mar 20") && pr.includes("2027-03-27") && pr.includes("Enforced"), "confirmed rule is saved with the admin's edit, marked AI-assisted, original text kept");
  await go("/rules/assist");
  await p.getByLabel("Restriction, in plain English").fill("Keep the new interns happy during their first month");
  await submit(p.getByRole("button", { name: "Turn into a rule" })); await p.locator('[data-testid="proposal"]').waitFor();
  ok((await p.locator('[data-testid="proposal"]').innerText()).includes("could not be matched to a template"), "text that cannot be mapped is proposed as a custom rule, not guessed");
  await save("Confirm and save rule");
  await go("/rules?engine=needs+review"); ok((await p.locator('[data-testid="rules-table"] tbody').innerText()).includes("Keep the new interns happy"), "the custom rule is saved flagged for manual review");
  await go("/rules"); await p.locator("tbody tr", { hasText: "No more than 60 scheduled clinical hours" }).getByRole("link").first().click(); await p.waitForURL(/rules\//);
  ok(!(await p.getByRole("button", { name: "Delete" }).count()), "system rules cannot be deleted");

  // ── settings ────────────────────────────────────────────────────────────
  await go("/settings"); await p.getByLabel("Requests off need approval before they count").uncheck(); await submit(p.getByRole("button", { name: "Save settings" }));
  await signIn("Dr. Adams"); ok((await text()).includes("Requests count as soon as you submit them"), "approval can be switched off program-wide, and the resident page says so");

  console.log(`\n${pass} passed, ${fails.length} failed`);
  const uniq = [...new Set(errors)];
  console.log(uniq.length ? "BROWSER ERRORS:\n" + uniq.slice(0, 10).join("\n") : "no browser errors");
  await b.close();
  process.exit(fails.length || uniq.length ? 1 : 0);
})().catch((e) => { console.error("CRASHED:", e.message.split("\n").slice(0, 6).join("\n")); process.exit(2); });
