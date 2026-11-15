// Wipes the database named in DATABASE_URL and rebuilds it from the SQL migrations plus the
// demo program. For development and tests only.   npm run db:reset
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { hashPassword } from "../src/lib/passwords";

const DEMO_PASSWORD = "cadence-demo-2027";

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.ALLOW_RESET !== "yes") throw new Error("Refusing to reset a database that is not on localhost (set ALLOW_RESET=yes to override).");
  let client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();
  // the same script a hosted site runs at start-up, so the reset exercises it every time
  execFileSync(process.execPath, [join(process.cwd(), "scripts", "migrate.mjs")], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
  client = new Client({ connectionString: url });
  await client.connect();
  if (!process.argv.includes("--empty")) {
    await client.query(readFileSync(join(process.cwd(), "prisma", "seed_demo.sql"), "utf8"));
    // Development and tests only: the three demo people can sign in with a known password.
    // A hosted site never runs this script; there, the demo people have no password at all.
    const hash = await hashPassword(DEMO_PASSWORD);
    await client.query(`UPDATE "User" SET "passwordHash" = $1, "passwordSetAt" = now()`, [hash]);
    console.log(`loaded demo program (demo sign-ins use the password "${DEMO_PASSWORD}")`);
  }
  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
