// Quick smoke: sign in as admin, open every list page and the first row's edit page.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3000";
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
  await require("./sign-in.cjs").signIn(p, BASE, "Pat Coordinator");
  await p.waitForURL("**/intervals");
  const slugs = (process.argv[2] || "institutions,roles,participants,shifts,categories,intervals,special-days,academic-days,vacation,requests").split(",");
  for (const s of slugs) {
    const r = await p.goto(BASE + "/" + s);
    const h1 = await p.locator("h1").first().innerText().catch(() => "?");
    const rows = await p.locator("tbody tr").count();
    let edit = "";
    if (s !== "intervals" && rows) {
      await p.locator("tbody tr td a").first().click();
      await p.waitForURL(new RegExp("/" + s + "/"));
      edit = " | edit: " + (await p.locator("h1").first().innerText()) + ", fields " + (await p.locator("form label").count());
    }
    const n = await p.goto(BASE + "/" + s + "/new");
    console.log(`${s}: ${r.status()} "${h1}" rows=${rows}${edit} | new ${n.status()}`);
  }
  for (const extra of ["rules", "rules/new", "rules/assist", "settings", "intervals/iv_7", "intervals/iv_7?tab=schedule", "intervals/iv_6?tab=schedule", "intervals/iv_6/schedules/sch_6", "intervals/iv_6/schedules/sch_6?view=shifts", "intervals/iv_6/schedules/sch_6?view=details", "access", "account", "assignments", "assignments?role=role_pgy2&sort=first", "assignments/p01?interval=iv_7", "assignments/p18?interval=iv_7", "assignments/p01?interval=iv_6", "shifts/s_bk", "academic-days/ac_conf"]) { const r = await p.goto(BASE + "/" + extra); console.log(`${extra}: ${r.status()} "${await p.locator("h1").first().innerText()}"`); }
  console.log(errors.length ? "ERRORS:\n" + [...new Set(errors)].slice(0, 12).join("\n") : "no browser errors");
  await b.close();
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
