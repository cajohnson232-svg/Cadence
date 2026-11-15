// Runs .sql files against DATABASE_URL. Used for the demo seed, and for applying the
// migrations where Prisma's migration engine is unavailable.  tsx scripts/sql.ts a.sql b.sql
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "pg";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  for (const file of process.argv.slice(2)) {
    await client.query(readFileSync(file, "utf8"));
    console.log("applied", file);
  }
  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
