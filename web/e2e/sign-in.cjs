// How the browser tests sign in: through the real sign-in form, as one of the demo people.
// (The local database reset gives the three demo people this password; a hosted site never has it.)
const EMAIL = { "Pat Coordinator": "coordinator@example.org", "Dr. Nguyen": "nguyen@example.org", "Dr. Adams": "adams@example.org" };
const DEMO_PASSWORD = "cadence-demo-2027";

async function signIn(p, BASE, name, password = DEMO_PASSWORD) {
  await p.context().clearCookies();
  await p.goto(BASE + "/login");
  await p.getByLabel("Email").fill(EMAIL[name] ?? name);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  await p.waitForLoadState("networkidle");
}
module.exports = { signIn, EMAIL, DEMO_PASSWORD };
