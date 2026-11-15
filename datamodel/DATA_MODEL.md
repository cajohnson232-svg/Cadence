# Cadence data model

The schema is `schema.prisma` (28 tables). It was reviewed on 13-14 Nov 2026 and the admin screens are now built on it.

**Stack** (your spec asked for the simplest conventional option): Next.js + TypeScript, PostgreSQL + Prisma,
Tailwind with shadcn-style components, Zod for form validation. Sign-in is a development stub for now (Auth.js is
the intended replacement). The scheduling engine stays a separate Python service.

**How far it has been tested.** The tables were created on a real PostgreSQL 16 server, loaded with a made-up
program that uses every table, compiled into engine input, scheduled (265 shifts, 18 people, zero hard-rule
violations), saved back, and exported to a calendar file. Prisma 7.10.1 validates the schema and generates its
client from it. The migration SQL has not been through Prisma's migration engine, which could not be downloaded
here; it was written by a small generator that follows Prisma's conventions.

## The tables

Your 13 entities are all here. **Bold** tables are ones I added.

| Group | Table | What it holds |
|---|---|---|
| Access | **Program** | One residency (the paying customer). Every other row belongs to a program |
| | **User**, **Membership** | A login (email, and since 15 Nov 2026 a stored password result, when it was last used, whether it is switched off); what that login may do in a program (Admin, Chief, Resident) and which participant it is |
| | **AccessLink** | A one-time link for choosing a password: an invitation or a reset. Only a fingerprint of the link is kept |
| | **SignInThrottle** | Counts of wrong sign-in attempts per email fingerprint and per network address |
| Setup | Institution | Name, short code, timezone, address, active |
| | **Area** | A pod inside an institution (Trauma/Medical, GP/CC). Optional |
| | Role | PGY-1 ... Attending, with level and default min/max shifts |
| | Participant | Name, email, phone, role, active, plus a private calendar-feed token |
| | **ShiftCategory** | Day / Evening / Swing / Night as *you* define them: rotation order, which count as nights |
| | Shift | The template: institution, area, category, start, length, days of week, min/max headcount |
| | **ShiftRole** | Per shift and role: the eligibility checkbox and required headcount |
| Schedule | Interval | Date range, draft -> locked -> published, request deadline and allowances |
| | Assignment | A participant's contract for a date range: institutions, shift count, eligible shifts |
| | Special staffing day (+ lines) | For one date and institution: replace the day's shifts, or add / change / remove individual ones |
| Time off | Academic day (+ roles, occurrences, exceptions) | Recurring session; a week can differ or be cancelled; per-person exceptions; blocked or excused |
| | TimeOff | Vacation, requests off, and the first/last-day-off presets, in one table |
| | ShiftAdjustment | +/- shifts for a participant in an interval, with a reason |
| Rules | Rule | The one rule table (below) |
| Output | **Schedule**, **ScheduledShift** | A generated or imported schedule; one row per person per shift. Drives the calendar export and the next block's boundary checks. A generated schedule also records its engine run: status (queued, running, done, failed, cancelled), time given, start and finish, a fingerprint of the inputs it was built from, and the reason if it failed |
| | **AuditLog** | Who changed what. Written today for schedule events: generate, cancel, publish, unpublish, discard |

## Where I departed from your spec, and why

1. **Program, User and Membership** are new. A site that several programs pay for needs each program's data kept
   apart, and sign-in needs somewhere to live. "Role" stays your scheduling role (PGY-1 ...); permission levels are
   called access levels to avoid two meanings of "role".
2. **Shift category is a table, not a fixed list.** The engine needs to know the rotation order and which shifts
   are nights; you define that per program instead of it being hard-coded.
3. **Required shift count is stored as a minimum and a maximum** on the assignment, pre-filled from the role. The
   engine needs a range; set both the same for an exact number. Adjustments move both.
4. **Vacation, requests off and first/last day off share one table** with a "kind". Your spec asked for the presets
   to be request types rather than separate systems; putting vacation there too gives one conversion to rules.
   The screens can still be separate.
5. **Time-off rows have a status** (pending, approved, denied). Only approved ones reach the engine; the compile
   step warns about pending ones.
6. **Academic day is a series plus exceptions**: the usual weekday and time, single weeks that differ or are
   cancelled, and people who are excused or additionally required. The blocked/excused choice from 13 Nov is a
   field on the series and can be overridden for one week.
7. **Schedules are stored** even though generating them is out of scope here, because the calendar export and the
   boundary rules between blocks need them. A schedule records whether it came from the engine, an import or manual entry.
8. **Times of day are stored as minutes after midnight plus a length.** The end time is derived, so shifts that
   cross midnight never need special handling. A shift's days of week are the days it *belongs to* (a night that
   starts at 00:30 Tuesday and belongs to Monday is listed under Monday).
9. **Soft rules have a priority and a weight.** The engine works through goals in strict priority order, so a
   weight alone cannot express "circadian rotation comes before balance". Priority is the tier; weight (1-10)
   ranks rules inside a tier.
10. **Nothing referenced can be deleted**: the database refuses, and the app archives instead.

## The unified rule system

One `Rule` table. Each rule has a scope (program / institution / role / participant), a template, typed
parameters, hard or soft (with weight and priority), active dates, notes, who created it, the original
plain-English text if it came from the AI box, and a needs-review flag.

Templates live in `rule-templates.json` (24 so far), each with a parameter schema the form and the database
compile step both validate against. A new program starts with 12 system rules (the ACGME limits and your
ordered goals), which are editable like any other rule.

| Template | Hard / soft | Engine today |
|---|---|---|
| Max clinical hours in any 7 days | hard | enforced |
| One 24-hour period off every 7 days | hard | enforced (always on) |
| Rest after a shift relative to its length | hard | enforced |
| Min hours off between shifts | hard / soft | enforced (hard, program-wide) |
| Max shifts per interval | hard | enforced (program, role or participant) |
| Max night shifts per interval; max runs of nights | hard | enforced |
| Cannot work (by date, weekday, time window, shift type, site) | hard / soft | enforced when hard. Chief days and "no overnights at County Jan-Mar" are this template |
| Forward rotation; balance days/evenings/nights; balance two areas | soft | enforced |
| Days between runs of nights; max share of nights; one run of nights; no night before vacation; keep days off together | soft | enforced |
| Max consecutive shifts; max shifts per week; max nights in a row; no night then day | hard / soft | stored only |
| Weekends worked per interval | hard / soft | stored only |
| Must / must not work with | hard / soft | stored only |
| Required headcount per shift per role | hard / soft | stored only |
| Custom (free text that could not be mapped) | - | never enforced; flagged for review |

"Stored only" means the rule is saved, shown and compiled, and the compiled view marks it as not yet enforced.
Nothing is silently dropped.

## Compiled rules for an interval

`compile_interval.py` produces, for one interval, a single uniform list: every active rule, every vacation,
request, preset, academic series, special staffing day and contract, each marked **enforced**, **stored only**,
**needs review** or **not included (pending / denied)**. This is the data for the read-only "Compiled rules for
this interval" view. For the demo block it has 53 entries, for example:

    Rule            HARD  enforced      Morgan Nguyen   Cannot work on Thu from 00:00 for 13h
    Rule            HARD  enforced      Harper Kim      Cannot work Night shifts at LBJ Hospital
    Rule            SOFT  stored only   Casey Chen      Must not be on shift at the same time as Devon Diaz
    Assignment      HARD  enforced      Blake Brooks    12-14 shifts at LBJ, MHH (adjusted -4: Vacation week)
    Request off     -     not included (pending)  Casey Chen   Off 2027-01-12 to 2027-01-12
    Academic day    HARD  enforced      Everyone        Wednesday conference: 3 session(s) in the interval; overlapping shifts are blocked; 1 personal exception(s)

It also returns warnings for the admin, such as "1 time-off request is still pending and is NOT included".

## What the test showed

* 13 kinds of bad data are refused by the database (overlapping assignments, overlapping intervals, deleting a
  role people still have, a second published schedule for one interval, a rule whose scope has no target, ...).
* 14 spot-checks that database inputs reached the schedule: the chief has nothing on Thursday mornings; Kim has
  no LBJ nights in her restricted dates; the vacation week is clear; the two-week rotator works only his dates and
  his listed shifts; the holiday runs only its four 12-hour shifts; the cancelled conference week has no session;
  the -2 chief adjustment changed the contract; a resident who ended the last block on nights starts late.
* The saved schedule exports to a calendar file, and the next block reads its last week as boundary history.

To make database rules reach the engine I added four small engine inputs: personal "cannot work" rules,
per-person shift eligibility, a minimum-hours rest rule, and per-person academic exceptions. The engine's own
test suites still pass. The 13-block test matrix was not re-run after these additions.

## Known gaps

* The engine staffs each shift to its **minimum total headcount**. Per-role headcounts and a max above the min
  are stored and flagged, not enforced.
* If an admin **reorders soft-rule priorities**, the engine still uses its built-in order and the compile step says so.
* A participant's role is their **current** role. Promotion each July is a bulk update; past schedules keep their
  shift rows but not the role held at the time.
* Scheduled shift times are stored as local wall-clock time at the institution.
* Billing (plans, payments) is not modelled yet.

## Decisions confirmed on 14 Nov 2026

1. **Shift count is a range** (min-max per assignment). Set both the same for an exact number.
2. **Requests off need approval before they count**, and the admin can turn requests off and on. That is built
   as three switches: approve / deny / turn off any single request; open or close requests for an interval
   (`Interval.requestsOpen`); and a program-wide setting for whether approval is needed at all
   (`Program.requestsRequireApproval`).
3. **The allowance is counted per day requested.**
4. **Soft rules have a priority and a weight.**

## Added for generating schedules from the app (14 Nov 2026)

* Eight fields on **Schedule** for the engine run (see the table above), and two database rules: one engine run
  at a time per interval, and only a finished schedule can be published.
* **Publishing belongs to a schedule, not to an interval.** Publishing a schedule marks its interval published
  and replaces whatever was published before; an interval can no longer be marked published with nothing to show.
* **A schedule knows what it was built from.** If a request is approved or a rule, shift or assignment changes
  afterwards, the schedule is flagged as out of date, and publishing it needs a deliberate tick.

## Added for real sign-in and hosting (15 Nov 2026)

* **AccessLink** and **SignInThrottle** (above), five fields on **User**, and one on **Schedule** recording which
  server instance is running an engine job.
* One database rule: an email address is stored in lower case, so the same address cannot be two accounts.
* Sign-in is by invitation only; see `web/README.md` for the rules and `DEPLOY.md` for putting it online.

## Screens

Built: see `web/README.md`. The schema file in the app (`web/prisma/schema.prisma`) is the same as
`datamodel/schema.prisma`.
