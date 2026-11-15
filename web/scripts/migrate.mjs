// Brings the database up to date when the site starts. Safe to run every time:
// it applies only the migrations in prisma/migrations that this database has not had yet, in order,
// each one all-or-nothing, and never removes data. If two copies start at once, one waits for the other.
//
//     node scripts/migrate.mjs            (uses DATABASE_URL)
//
// What has been applied is recorded in the _prisma_migrations table, in the form Prisma's own
// migration tool uses, so that tool can take over later.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "prisma", "migrations");
if (existsSync(join(here, "..", ".env"))) {
  for (const line of readFileSync(join(here, "..", ".env"), "utf8").split("\n")) {       // a local .env, if there is one; real settings win
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
if (!process.env.DATABASE_URL) { console.error("migrate: DATABASE_URL is not set."); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(7203002)");
  await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
  const done = new Set((await client.query(`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`)).rows.map((r) => r.migration_name));
  // A database built before this script existed (by the development reset) has the tables but no record of them.
  const hasTables = (await client.query(`SELECT to_regclass('public."Program"') IS NOT NULL AS yes`)).rows[0].yes;
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (hasTables && done.size === 0) {
    console.error(`migrate: this database already has Cadence's tables but no record of which migrations made them.\n` +
      `It was probably created with "npm run db:reset". Start from an empty database, or run "npm run db:reset" again (it now records them).`);
    process.exit(1);
  }
  let applied = 0;
  for (const name of names) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
    const id = randomUUID();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "finished_at", "applied_steps_count") VALUES ($1, $2, $3, now(), 1)`,
        [id, createHash("sha256").update(sql).digest("hex"), name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`migrate: ${name} failed and was rolled back; nothing from it was kept.\n${e.message}`);
      process.exit(1);
    }
    console.log(`migrate: applied ${name}`);
    applied++;
  }
  console.log(applied ? `migrate: database is up to date (${applied} applied).` : "migrate: database is already up to date.");
} catch (e) {
  console.error(`migrate: could not reach the database. ${e.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
