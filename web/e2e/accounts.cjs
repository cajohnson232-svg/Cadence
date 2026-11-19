// A new hosted site, from first visit to people signing in, in a real browser.
// Needs a site that has never been set up (an empty database) and its setup key:
//
//   npm run db:reset -- --empty
//   SETUP_KEY=some-long-setup-key-123 npm start            (in one shell)
//   SETUP_KEY=some-long-setup-key-123 node e2e/accounts.cjs   (in another)
//
// It ends by generating and publishing a schedule and then starting over, so it also shows the engine
// working on the hosted layout. Takes about two minutes.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3000";
const KEY = process.env.SETUP_KEY;
const SHOTS = process.env.SHOTS || "/tmp/shots";
require("fs").mkdirSync(SHOTS, { recursive: true });
let pass = 0; const fails = [];
const ok = (cond, what) => { if (cond) { pass++; console.log("ok   " + what); } else { fails.push(what); console.log("FAIL " + what); } };
const ME = { name: "Dana Director", email: "dana@riverside-em.example", password: "seven green bicycles" };

(async () => {
  if (!KEY) throw new Error("Set SETUP_KEY to the same value the site was started with.");
  const b = await chromium.launch();
  const errors = [];
  const open = async () => {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text().slice(0, 300)); });
    return { ctx, p };
  };
  const go = async (p, path) => { const r = await p.goto(BASE + path); await p.waitForLoadState("networkidle"); return r; };
  const text = (p) => p.locator("body").innerText();
  const alert = (p) => p.locator('p[role="alert"]').first().innerText({ timeout: 15000 }).catch(() => "");      // the app's own messages (not the browser's page-change announcer)
  const settle = async (p) => { await p.waitForLoadState("networkidle"); await p.waitForTimeout(350); };
  const signIn = async (p, email, password, expectIn = true) => {
    await go(p, "/login");
    await p.getByLabel("Email").fill(email); await p.getByLabel("Password").fill(password);
    await p.getByRole("button", { name: "Sign in" }).click();
    if (expectIn) { await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }); await settle(p); return ""; }
    return alert(p);
  };
  const signOut = async (p) => { await p.getByRole("button", { name: "Sign out", exact: true }).click(); await p.waitForURL(/\/login/); await settle(p); };
  const join = async (p, link, password, again = password) => {
    await p.goto(link); await p.waitForLoadState("networkidle");
    await p.getByLabel(/Choose a password|New password/).fill(password); await p.getByLabel("Type it again").fill(again);
    await p.getByRole("button", { name: /Create my sign-in|Save password and sign in/ }).click();
  };
  // click something on the access screen and wait for the server's answer to show
  const act = async (p, click) => { const answered = p.waitForResponse((r) => r.request().method() === "POST", { timeout: 30000 }); await click(); await answered; await settle(p); };
  const linkFor = async (p, row, button) => {
    await act(p, () => row.getByRole("button", { name: button }).click());
    await p.getByTestId("link-card").waitFor({ timeout: 15000 });
    return p.getByTestId("link-value").inputValue();
  };
  const row = (p, email) => p.locator(`tr[data-email="${email}"]`);

  // ── a site nobody has set up ─────────────────────────────────────────────
  const A = await open(), admin = A.p;
  await go(admin, "/");
  ok(admin.url().endsWith("/setup"), "a brand-new site sends the first visitor to setup");
  const res = await A.ctx.request.get(BASE + "/api/health");
  ok(res.status() === 200 && (await res.json()).ok === true, "the health check answers");
  const h = (await A.ctx.request.get(BASE + "/login", { maxRedirects: 0 })).headers();
  ok(h["x-frame-options"] === "DENY" && h["x-content-type-options"] === "nosniff" && /max-age/.test(h["strict-transport-security"] ?? "") && !h["x-powered-by"], "pages carry the security headers");
  ok(/Disallow: \//.test(await (await A.ctx.request.get(BASE + "/robots.txt")).text()), "search engines are told to stay out");
  ok((await A.ctx.request.get(BASE + "/intervals", { maxRedirects: 0 })).status() === 307 && (await A.ctx.request.get(BASE + "/access", { maxRedirects: 0 })).status() === 307, "nothing inside is reachable without signing in");

  const fill = async (key, password, again = password) => {
    await go(admin, "/setup");
    await admin.getByLabel("Setup key").fill(key); await admin.getByLabel("Your name").fill(ME.name); await admin.getByLabel("Your email").fill("Dana@Riverside-EM.example");
    await admin.getByLabel("Choose a password").fill(password); await admin.getByLabel("Type it again").fill(again);
    await admin.getByRole("button", { name: "Set up this site" }).click();
  };
  await fill("not-the-setup-key-0000", ME.password);
  ok(/That setup key is not right/.test(await alert(admin)), "setup is refused without the right setup key");
  await fill(KEY, "short");
  ok(admin.url().endsWith("/setup"), "setup with a too-short password does not go through");
  await fill(KEY, ME.password, ME.password + "x");
  ok(/not the same/.test(await alert(admin)), "the two passwords must match");
  await go(admin, "/login");
  ok(admin.url().endsWith("/setup"), "after refused attempts the site is still not set up");
  await fill(KEY, ME.password);
  await admin.waitForURL(/\/intervals/, { timeout: 60000 }); await settle(admin);
  ok(/This site is set up and you are its administrator/.test(await text(admin)) && /Dana Director/.test(await text(admin)) && /Demo EM Residency/.test(await text(admin)), "with the key, setup creates the administrator and opens the demo program");
  const cookie = (await A.ctx.cookies()).find((c) => c.name === "cadence_session");
  ok(cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.expires - Date.now() / 1000 > 29 * 86400, "the sign-in cookie cannot be read by scripts, is not sent from other sites, and lasts 30 days");
  await admin.screenshot({ path: `${SHOTS}/host-after-setup.png` });

  const B = await open(), other = B.p;
  await go(other, "/setup");
  ok(other.url().endsWith("/login"), "setup is closed once it has been done");
  ok(/do not match/.test(await signIn(other, "coordinator@example.org", "cadence-demo-2027", false)), "the demo people have no password on a hosted site");
  ok(/do not match/.test(await signIn(other, "nobody@nowhere.example", "whatever-password", false)), "an unknown email gets the same answer");

  // ── inviting a resident ──────────────────────────────────────────────────
  await go(admin, "/access");
  ok((await row(admin, ME.email).innerText()).includes("You") && /Active/.test(await row(admin, ME.email).innerText()), "the access screen lists me as the active administrator (email stored in lower case)");
  ok(/No password yet/.test(await row(admin, "adams@example.org").innerText()) && (await admin.getByTestId("participants-waiting").locator("tbody tr").count()) === 16, "demo people are listed with no password; 16 participants have no sign-in");
  const invite = await linkFor(admin, row(admin, "adams@example.org"), "Make invite link");
  ok(new RegExp(`^${BASE}/join/[A-Za-z0-9_-]{43}$`).test(invite), "an invite link is made and shown, on this site's own address");
  ok(/Invited/.test(await row(admin, "adams@example.org").innerText()), "the person shows as invited");
  await admin.screenshot({ path: `${SHOTS}/host-access.png`, fullPage: true });

  await other.goto(invite); await other.waitForLoadState("networkidle");
  ok(/Demo EM Residency has invited you/.test(await text(other)) && /adams@example\.org/.test(await text(other)), "the link opens a page naming the program and the email it is for");
  await other.screenshot({ path: `${SHOTS}/host-join.png` });
  await join(other, invite, "adams-password-1");
  ok(/Do not use your email address/.test(await alert(other)), "a password built on the email address is refused");
  await join(other, invite, "password123");
  ok(/most commonly used/.test(await alert(other)), "a very common password is refused");
  await join(other, invite, "quiet river stones", "quiet river stone");
  ok(/not the same/.test(await alert(other)), "the two passwords must match");
  await join(other, invite, "quiet river stones");
  await other.waitForURL(/\/me$/, { timeout: 30000 }); await settle(other);
  ok(/Avery Adams/.test(await text(other)), "choosing a password signs the resident in on their own page");
  const C = await open();
  await C.p.goto(invite); await C.p.waitForLoadState("networkidle");
  ok(/expired or has already been used/.test(await text(C.p)), "the link does not work a second time");
  await go(other, "/access"); ok(other.url().endsWith("/me"), "a resident cannot open the access screen");
  await go(other, "/intervals"); ok(other.url().endsWith("/me"), "or any admin screen");
  await go(other, "/setup"); ok(!other.url().endsWith("/setup"), "or setup");

  // ── wrong passwords, lock, reset link ────────────────────────────────────
  await signOut(other);
  for (let i = 0; i < 5; i++) await signIn(other, "adams@example.org", "wrong guess " + i, false);
  ok(/Too many attempts\. Try again in 15 minutes/.test(await signIn(other, "adams@example.org", "quiet river stones", false)), "five wrong passwords lock the account for 15 minutes, even for the right password");
  await go(admin, "/access");
  const reset = await linkFor(admin, row(admin, "adams@example.org"), "Make reset link");
  ok(/Password reset link for/.test(await admin.getByTestId("link-card").innerText()), "the administrator can make a reset link");
  await join(other, reset, "bright copper kettles");
  await other.waitForURL(/\/me$/, { timeout: 30000 }); await settle(other);
  ok(true, "the reset link sets a new password, clears the lock and signs them in");
  await signOut(other);
  ok(/do not match/.test(await signIn(other, "adams@example.org", "quiet river stones", false)), "the old password no longer works");
  await signIn(other, "adams@example.org", "bright copper kettles");
  ok(other.url().endsWith("/me"), "the new one does");

  // ── switching a sign-in off signs the person out at once ─────────────────
  await go(admin, "/access");
  await act(admin, () => row(admin, "adams@example.org").getByRole("button", { name: "Switch sign-in off" }).click());
  ok(/Switched off/.test(await row(admin, "adams@example.org").innerText()), "an administrator can switch a sign-in off");
  await go(other, "/me");
  ok(other.url().endsWith("/login"), "the person is signed out on their next click");
  ok(/do not match/.test(await signIn(other, "adams@example.org", "bright copper kettles", false)), "and cannot sign back in");
  await act(admin, () => row(admin, "adams@example.org").getByRole("button", { name: "Switch sign-in on" }).click());
  await signIn(other, "adams@example.org", "bright copper kettles");
  ok(other.url().endsWith("/me"), "switching it back on lets them in with the same password");

  // ── a participant with no sign-in yet; a chief; a second administrator ───
  const brooks = await linkFor(admin, admin.getByTestId("participants-waiting").locator("tbody tr", { hasText: "Blake Brooks" }), "Give a sign-in and make invite link");
  ok(/sees Blake Brooks's schedule/.test(await row(admin, "brooks@example.org").innerText()) && (await admin.getByTestId("participants-waiting").locator("tbody tr").count()) === 15, "a participant can be given a sign-in tied to their own schedule");
  ok(brooks !== invite, "each link is different");
  const chiefLink = await linkFor(admin, row(admin, "nguyen@example.org"), "Make invite link");
  await join(C.p, chiefLink, "morning coffee first");
  await C.p.waitForURL(/\/intervals/, { timeout: 30000 }); await settle(C.p);
  await go(C.p, "/access");
  ok(C.p.url().endsWith("/intervals") && (await C.p.getByRole("link", { name: "Sign-in & access" }).count()) === 0, "a chief can edit schedules but has no access screen");
  await go(C.p, "/settings");
  ok((await C.p.getByTestId("start-over").count()) === 0, "and cannot start the program over");
  await admin.getByTestId("add-person").getByLabel("Name").fill("Sam Second"); await admin.getByTestId("add-person").getByLabel("Email").fill("Sam.Second@Example.org");
  await act(admin, () => admin.getByRole("button", { name: "Add and make invite link" }).click());
  const samLink = await admin.getByTestId("link-value").inputValue();
  ok(/Administrator/.test(await row(admin, "sam.second@example.org").locator("select").evaluate((s) => s.selectedOptions[0].text)), "a second administrator can be added (email stored in lower case)");
  const D = await open();
  await join(D.p, samLink, "second admin password");
  await D.p.waitForURL(/\/intervals/, { timeout: 30000 }); await settle(D.p);
  await go(D.p, "/access");
  ok(D.p.url().endsWith("/access"), "the second administrator can open the access screen");
  await go(admin, "/access");
  ok((await row(admin, ME.email).getByRole("button", { name: /Switch sign-in off|Remove/ }).count()) === 0, "you cannot switch off or remove your own access");
  await act(admin, () => row(admin, ME.email).locator("select").selectOption("CHIEF"));
  ok(/cannot remove your own administrator access/.test(await admin.getByTestId("access-error").innerText()), "or demote yourself");
  admin.once("dialog", (d) => d.accept());
  await act(admin, () => row(admin, "coordinator@example.org").getByRole("button", { name: "Remove" }).click());
  ok((await row(admin, "coordinator@example.org").count()) === 0, "someone's access can be removed altogether");

  // ── changing your own password signs your other devices out ──────────────
  const E = await open();
  await signIn(E.p, "adams@example.org", "bright copper kettles");
  await go(other, "/account");
  await other.getByLabel("Current password").fill("not my password"); await other.getByLabel("New password").fill("lantern on the porch"); await other.getByLabel("Type it again").fill("lantern on the porch");
  await other.getByRole("button", { name: "Change password" }).click();
  ok(/current password is not right/.test(await alert(other)), "changing a password needs the current one");
  await go(other, "/account");
  await other.getByLabel("Current password").fill("bright copper kettles"); await other.getByLabel("New password").fill("lantern on the porch"); await other.getByLabel("Type it again").fill("lantern on the porch");
  await other.getByRole("button", { name: "Change password" }).click();
  ok(/Password changed/.test(await alert(other)), "a resident can change their own password");
  await go(other, "/me"); ok(other.url().endsWith("/me"), "the device that changed it stays signed in");
  await go(E.p, "/me"); ok(E.p.url().endsWith("/login"), "their other device is signed out");

  // ── a forged cookie gets nowhere ─────────────────────────────────────────
  const mine = (await A.ctx.cookies()).find((c) => c.name === "cadence_session");
  const F = await open();
  const parts = mine.value.split(".");
  for (const [label, value] of [["a changed user", ["v1", "someone-else", parts[2], parts[3], parts[4]].join(".")], ["a changed date", [parts[0], parts[1], parts[2], String(Number(parts[3]) + 999999), parts[4]].join(".")], ["no signature", parts.slice(0, 4).join(".") + "."]]) {
    await F.ctx.clearCookies(); await F.ctx.addCookies([{ ...mine, value }]);
    await go(F.p, "/intervals");
    ok(F.p.url().endsWith("/login"), `a sign-in cookie with ${label} is refused`);
  }

  // ── the engine, on the hosted layout ─────────────────────────────────────
  await go(admin, "/intervals/iv_7?tab=schedule");
  await admin.locator('select[name="budget"]').selectOption("quick");
  await admin.getByTestId("generate-card").getByRole("button", { name: "Generate schedule" }).click();
  await admin.waitForURL(/\/schedules\/[^/?]+$/, { timeout: 200000 }); await settle(admin);
  ok((await admin.getByTestId("rule-check").innerText()) === "None broken" && /265\s+of 265/.test(await admin.getByTestId("summary").innerText()), "the engine generates a full schedule with no hard rule broken");
  const before = admin.url();
  await admin.getByTestId("publish-card").getByRole("button", { name: "Publish schedule" }).click();
  await admin.waitForFunction((u) => location.href !== u, before, { timeout: 30000 }); await settle(admin);
  ok((await admin.getByTestId("schedule-status").innerText()) === "Published", "and it can be published");
  await go(other, "/me");
  ok((await other.locator("section", { hasText: "Published shifts" }).locator("tbody tr", { hasText: /Jan ([4-9]|[12]\d|3[01]), 2027/ }).count()) >= 14, "the invited resident sees their published shifts");
  await other.screenshot({ path: `${SHOTS}/host-resident.png`, fullPage: true });

  // ── start over ───────────────────────────────────────────────────────────
  await go(admin, "/settings");
  await admin.getByTestId("start-over").getByLabel(/To confirm/).fill("demo em residency");
  await admin.getByRole("button", { name: "Remove everything and start over" }).click();
  ok(/type the program's name exactly/.test(await alert(admin)), "starting over needs the program's name typed exactly");
  await admin.screenshot({ path: `${SHOTS}/host-start-over.png`, fullPage: true });
  await admin.getByTestId("start-over").getByLabel(/To confirm/).fill("Demo EM Residency");
  await admin.getByTestId("start-over").getByLabel(/Name for the new/).fill("Riverside EM");
  await admin.getByRole("button", { name: "Remove everything and start over" }).click();
  await admin.waitForURL(/notice=/, { timeout: 60000 }); await settle(admin);
  ok(/Everything was removed/.test(await text(admin)) && /Riverside EM/.test(await text(admin)), "start over empties the program and renames it");
  await go(admin, "/participants"); const none = /Nothing|No participants|0 /.test(await text(admin)) && (await admin.locator("tbody tr td a").count()) === 0;
  await go(admin, "/rules"); const rules = await admin.locator("tbody tr").count();
  await go(admin, "/intervals"); const intervals = await admin.locator("tbody tr td a").count();
  ok(none && rules === 13 && intervals === 0, "no participants or intervals are left; the 13 standard rules are back");
  await go(admin, "/access");
  const left = await admin.getByTestId("people-with-access").locator("tbody tr").evaluateAll((r) => r.map((x) => x.getAttribute("data-email")).sort().join());
  ok(left === `${ME.email},sam.second@example.org`, "both administrators keep their sign-in; everyone else's access is gone");
  await go(other, "/me"); ok(other.url().endsWith("/login"), "the resident from the demo is signed out");
  await go(C.p, "/intervals"); ok(C.p.url().endsWith("/login"), "and so is the chief");

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) console.log("FAILED:\n  " + fails.join("\n  "));
  console.log(errors.length ? "BROWSER ERRORS:\n" + [...new Set(errors)].slice(0, 10).join("\n") : "no browser errors");
  await b.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("FAILED", e.message.split("\n").slice(0, 6).join("\n")); process.exit(1); });
