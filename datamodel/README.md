# Cadence data model

The database design for the admin and resident web app, plus the bridge that turns an interval's
inputs into the scheduling engine's input and stores the result.

## Stack choices

Your spec gave the stack as an example and asked for the simplest conventional option, so:

* **Next.js (App Router) + TypeScript** for the app, **Tailwind + shadcn/ui** for the screens.
* **PostgreSQL + Prisma** for data. `schema.prisma` is the source of truth.
* Sign-in is built into the app (email and password, by invitation); see `web/README.md`.
* **Zod** for form validation; rule parameters are validated against `rule-templates.json`.
* The scheduling engine stays a separate **Python** program; the app compiles its input (`web/src/lib/compile.ts`).

## Files

| File | What it is |
|---|---|
| `schema.prisma` | 29 tables, 16 enums. Identical to `web/prisma/schema.prisma` |
| `constraints.sql` | Rules Prisma cannot express (no overlapping assignments or intervals, end after start, one published schedule per interval, rule scope must match its target, ...) |
| `rule-templates.json` | The rule template library: 25 templates with typed parameters, and the 13 system rules a new program starts with |
| `compile_interval.py` | LEGACY (since 17 Nov 2026): the first database -> engine input bridge, kept for `test_datamodel.py`. The app uses `web/src/lib/compile.ts`, which also handles backup shifts, site split and personal academic days |
| `seed_demo.py` / `seed_demo.sql` | A made-up program that uses every table |
| `test_datamodel.py` | End-to-end test against a real PostgreSQL server |
| `tools/prisma_check.py` | Structural schema check and SQL generator, standing in for Prisma where it is not installed |
| `demo_output/` | Block 7 from the demo: engine input, compiled rules, one resident's calendar file |

## Run the test

    # needs a PostgreSQL server you can create databases on
    PGHOST=... PGPORT=... PGUSER=... python datamodel/test_datamodel.py

## What has and has not been checked

Checked, on PostgreSQL 16:

* the schema is structurally sound (every relation has both sides, keys and types line up) and loads: 28 tables, 60 foreign keys;
* the database refuses 13 kinds of bad data (overlapping assignments, deleting a role people still have, a second
  published schedule, ...);
* the demo program compiles into engine input, the engine schedules it (265 shifts, 18 participants) with zero
  hard-rule violations, and 14 spot-checks confirm that specific database inputs reached the schedule;
* the schedule saves back, a calendar file exports, and the next block picks up its boundary history from it.

Also checked: Prisma 7.10.1 validates `schema.prisma` and generates its client. (Until 17 Nov 2026 the app's compile
step also produced exactly the same engine input as `compile_interval.py`; the app's version has since gone further.)

Not checked:

* **The migration SQL has not been through Prisma's migration engine** (its binary could not be downloaded here).
  The tables are created by `tools/prisma_check.py`, which follows Prisma's conventions but is not Prisma.
