# Cadence web app

The admin and resident screens that collect everything the scheduling engine needs for an
interval. Admin first; the resident page is a working first version.

## Stack (and why)

Your spec gave the stack as an example and asked for the simplest conventional option:

| Choice | Note |
|---|---|
| Next.js 16 (App Router) + React 19 + TypeScript | Server components for lists, server actions for saves |
| PostgreSQL + Prisma 7 | `prisma/schema.prisma` is the data model; the client uses Prisma's pg driver adapter |
| Tailwind CSS 4 | |
| shadcn-style components | `src/components/ui/*` are hand-written in the shadcn pattern (cva + tailwind-merge). The shadcn CLI could not be used here because its registry was outside the allowed network; `npx shadcn add ...` can replace them later without touching the screens |
| Sign-in | Built in (15 Nov 2026): email and password, by invitation only. No outside sign-in service. Details under "Sign-in and access" |
| Plain-English input | Claude (Anthropic API) when `ANTHROPIC_API_KEY` is set; otherwise a built-in keyword reader. Details under "Claude in the app" |

## Run it

**To put it online, follow `DEPLOY.md` in the folder above this one.** What follows is for running it on your own machine.

    cp .env.example .env                  # set DATABASE_URL to an empty PostgreSQL database, and SESSION_SECRET to a long random value
    npm install
    npx prisma generate
    pip install -r ../requirements.txt    # the scheduling engine's Python packages (NumPy, SciPy; OR-Tools optional)
    npm run db:reset                      # LOCAL ONLY: wipes the database, builds the tables, loads the demo program
    npm run dev                           # http://localhost:3000

After `npm run db:reset` the three demo people can sign in with the password `cadence-demo-2027`:
`coordinator@example.org` (administrator), `nguyen@example.org` (chief), `adams@example.org` (resident).
That password exists only on a database built by this command on your own machine.

For a database you want to keep, use `npm run db:migrate` instead of the reset: it applies only the migrations
the database has not had yet and never removes data. A hosted site runs it by itself every time it starts.
Then open the site and it takes you through first-time setup.

The app starts the scheduling engine itself, so the engine has to be on the same machine: by default it looks for
`run.py` in the folder above this one (how the package is laid out) and runs it with `python3`. `ENGINE_DIR` and
`ENGINE_PYTHON` in `.env` change that.

## Screens

Left navigation, grouped as in the spec:

* **Setup**: Institutions (with areas), Roles (with shift eligibility), Participants, Shifts (with the role grid), Shift categories
* **Schedule**: Intervals, Assignments (one page per participant and interval), Special Staffing Days
* **Time Off & Preferences**: Academic Days (with weekly changes, dates it does not happen and personal exceptions), Vacation, Requests Off
* **Rules**: Rules (one list, hard and soft), Other Restrictions (plain English)
* Program settings

Every list has search and filters; every entity has a create/edit form; anything still referenced is
archived instead of deleted and can be restored.

**Sign-in and access** (added 15 Nov 2026):

* **By invitation only.** Nobody can create their own account. An administrator makes a one-time link for a
  person on the Sign-in & access screen and sends it to them; the person chooses their own password. The site
  sends no email.
* **Three levels.** Administrators do everything, including deciding who has access. Chiefs edit setup, rules
  and schedules but cannot change access or start the program over. Residents see only their own page.
* **Passwords** are at least 10 characters, with very common ones and ones built on the person's email refused.
  They are stored only as a salted scrypt result.
* **Links** work once. An invitation lasts 7 days, a password reset 24 hours. Only a fingerprint of a link is
  stored, so it is shown once, when made. Making a new link cancels the previous one.
* **Wrong passwords:** five in 15 minutes lock that email address for 15 minutes; thirty from one network
  address lock that address. A wrong password, an unknown email and a switched-off account all get the same
  answer.
* **Sessions** last 30 days. Changing or resetting a password, or an administrator switching a sign-in off,
  signs the person out everywhere at once.
* **Guard rails:** the last administrator who can sign in cannot be demoted, switched off or removed, and
  nobody can remove their own administrator access.
* **First-time setup** (`/setup`) creates the first administrator and the program, starting from the demo
  program or an empty one. It needs the server's `SETUP_KEY` and closes for good once anybody can sign in.
* **Start over** (Program settings, administrators only) removes everything in the program and puts back an
  empty one. It asks for the program's name typed out.
* **Your account** (every signed-in person): change password, sign out everywhere.
* Invitations, resets, access changes, password changes and start-over are written to the audit log.

**Assignments** (reorganised 17 Nov 2026). The tab lists participants, with search, a role filter, sorting by
last or first name, and which of the latest intervals each person is assigned to. A participant's page has an
interval picker; below it, for that interval:

* **Summary.** Shift counts and eligible shifts come from the role (counts set on old assignments were cleared when
  this version was installed). Adjustments are added to the role's numbers. Assignments cover the whole interval.
* **Institutions.** With more than one, the share of shifts at each is required and must add up to 100%; the
  schedule aims for it and counts it as met within one shift either way (a soft goal, third in priority). Optional
  "only from / only until" dates per institution (for example two weeks at each); without dates, either one at any time.
* **Adjustments** (moved here from Time Off & Preferences): extra shifts or a reduction, reason optional.
* **Required time off**: dates, or a time window on those dates, always enforced. For last-minute changes.
* **No nights** (always enforced) and **notes** for the record. Notes are shown with the compiled rules.
* **Personal academic days**: like the program's academic days, for this person only, with dates it does not happen
  and the yes/no "If a shift overlaps this session, the individual cannot work it".

**Academic days** now have "Dates it does not happen" (holidays and so on), and the overlap question is the same
yes/no: yes means a shift that overlaps cannot be worked (a hard rule).

**Backup shifts.** A shift can be marked "This is a backup shift". One person is then on backup every day it is
active, at its own time and length. It is on call only by default: it does not count as a shift or toward hours
(a tick changes that). Its rules are typed in plain words ("PGY-2 and up only, at most 3 each, 3 days apart") and
read into editable fields: most per person, days between, hours off before and after, and which roles can take it
(saving updates the role grid). Nobody is put on backup on a day they work a clinical shift, on vacation or required
time off, or in their weekly 24 hours off. Backup is chosen after the clinical schedule is final, by an exact
optimisation that spreads it evenly; a day nobody can take is shown open, with the reasons. Review shows backup
days as BU, a "Backup days covered" tile and a Backup section; the spreadsheet and calendar mark them on call.

**Special staffing days** now have their own form. **Modify**: describe the changes in words, "Read the changes"
turns them into lines you can edit (a shift that does not run, a changed time or headcount, an extra shift), then
save. **Replace**: tick the shifts that run that day, inactive ones included, with an optional time, length or
headcount for that day only.

**How the previous interval ended.** When nothing is published for the interval before, the Schedule tab asks for the
shifts worked in the 7 days before it: one at a time, or pasted ("name, date, shift name", commas or tabs). The
engine uses them for rest after nights and the weekly hours limit across the boundary. Shifts of people not in the
interval are ignored, with a warning.

**Optimize.** A finished schedule that breaks no hard rule can be optimized for 1, 5 or 15 minutes. The engine starts
from that schedule and keeps working on the soft goals; no goal gets worse unless a goal above it improves. The result
is a new draft ("Run 3 (optimized from Run 2)"); the original is unchanged. Backup is chosen again for the new
schedule, so its backup days can differ. A schedule whose inputs have changed since cannot be optimized.

**Two hard rules tightened (18 Nov 2026).**

* **Shift eligibility.** Every person is now sent to the engine with their own list of allowed shifts, taken from the
  role grid every time (before, the list was only sent when the grid could not be expressed as "PGY-x and up"). On top
  of the engine's own checker, the site checks every stored shift and backup day against the role grids as they are
  now: any mismatch is listed on the review page and the schedule cannot be published, even with the tick (for
  example when a grid is changed after the schedule was generated). An extra shift on a special staffing day must say
  which normal shift it is like; that shift's grid decides who can work it. Optimize matches shifts by id, so two
  shifts with the same name and times are never confused.
  The list sent for each person also leaves out shifts at institutions they are not assigned to for the interval.
  **Before every run**, the site re-derives from the database, independently of the compile step, who may work each
  shift (role grid and institutions) and refuses to start the engine if what it is about to send lets anyone through
  that the grid forbids. **After a run**, the review page also checks institutions and their "only from / until"
  dates, and for a role-grid problem it says why, from the inputs stored with the run: the run was made by an
  earlier version of the site; the grid or the person's role changed after it was generated; or the engine was told
  no and did it anyway (an engine fault).
* **At most 6 days worked in a row** (a new standard rule, "Max days worked in a row", hard). A day counts when a
  shift belongs to it, so a night counts on the evening it starts; backup (on call) does not count; the previous
  interval's last week does. It can be set per role or person to a smaller number; the tightest applies.

**Minimum and maximum headcount (19 Nov 2026).** A shift's minimum headcount must be filled; places above it, up
to its maximum, are optional. The engine uses an optional place only where it gets someone to their minimum number
of shifts without breaking any rule ("Extra people only where needed", the goal right after "Everyone reaches their
minimum shifts"): a second person on an LBJ evening or night set to 1-2, or a PGY-3 on a 0-1 Dugout so that PGY-1s and
PGY-2s keep the shifts they need. It uses no more of them than that, and never more than the maximum. Optional places
it does not use are not stored and are not open shifts; the review's "Shifts filled" counts required places and
lists extra people separately. A shift with a minimum of 0 is a shift nobody has to work. The Coverage tab shows
ranges as 1–2.

**Claude in the app.** With `ANTHROPIC_API_KEY` set, three things are read by Claude: Other Restrictions, backup rules
and special-day changes. What is sent: the sentence typed, and the names and ids of the program's roles, shifts,
categories and institutions needed to understand it; for Other Restrictions only, also participants' names and ids
(so "Adams cannot work nights" can name a person). No schedules, time off, notes or email addresses are sent. Claude's answer is always a
proposal the admin checks and edits before saving. If the key is missing, wrong or the service fails, the built-in
keyword reader is used and the screen says which one read the text. `ANTHROPIC_MODEL` picks the model
(default `claude-sonnet-5-5`).

**Interval hub** (`/intervals/<id>`): Coverage (shifts x days with headcount, special staffing days and
academic time applied), Requests & vacations per participant with allowance used, Adjustments with the
resulting contracts, the read-only Compiled rules list, and Schedule. It also has Lock inputs, the open/close
switch for requests, and "Download engine input", which is the JSON the Python engine reads.

**Generate, review, publish** (added 14 Nov 2026):

* **Generate schedule** on the interval page opens the Schedule tab. It says what will be scheduled, lists anything
  to know first (for example a request still pending that will not be included), and offers three amounts of time:
  quick (about 1 minute), standard (5) and thorough (15). Hard rules hold whichever is chosen.
* The engine runs in the background. The page shows what it is doing and the time used, and the run can be
  cancelled. Leaving the page, or restarting the web server, does not stop it. One run at a time per interval.
* When it finishes, the result opens by itself as a **draft**: a by-person grid, a by-shift grid, open shifts each
  with the reason nobody else can take them, the goals in priority order with their scores, per-person figures,
  the independent rule check, and a spreadsheet download.
* **Publish** shows the shifts to participants (their page and calendar link), marks the interval published,
  and makes the schedule's last week the starting point for the next interval. Publishing is refused if the rule
  check found a hard rule broken. It needs a deliberate tick if shifts are still open or if the inputs have
  changed since the schedule was generated (the review page says so). Publishing a newer schedule replaces the
  older one; **Unpublish** takes it back to a draft; drafts can be discarded.
* Every run is kept as its own schedule until discarded. Generating, cancelling, publishing, unpublishing and
  discarding are written to the audit log.

**Calendar view** (added 18 Nov 2026). The review page's **Calendar** tab shows the schedule as a month-style grid:
one box per date (whole weeks, Monday to Sunday), listing every shift that day in start order with the resident on it
(first initial and last name; hover for full names and times). Shifts with more than one person list everyone; a
place nobody is on yet shows OPEN in red; backup (on call) is listed last as "Backup". Buttons switch between all
institutions together (each line marked with its institution's code) and one institution at a time (here: All (LBJ +
MHH), LBJ only, MHH only). A night is listed on the day it starts (an after-midnight start, on the evening before).
Program academic days are noted in the corner of the box; personal ones are not. **Printable** opens the calendar on
a page of its own: this view, or all three views, each on its own landscape page; print it or save it as a PDF from
the browser's print dialog. The colours match the shift categories in the by-person grid.

**Requests off** (your answers of 14 Nov):

* Counted **per day requested** against the interval's allowance, with a separate high-priority allowance.
* **Need approval** before they count. Three switches for the admin: approve / deny / turn off any single
  request; open or close requests for an interval; and a program-wide setting for whether approval is needed at all.
* Going over the allowance is refused for residents and needs an explicit override tick for admins.

**Other restrictions**: type a sentence, get a proposed rule next to your original text with a note on how it
was read, edit any field, then confirm. Nothing is saved before the confirm click; the original wording is kept
on the rule; text that cannot be mapped is saved as a custom rule flagged for manual review.

**Resident page** (`/me`): own assignments, vacation, academic time, published shifts, requests with allowance
used, a form to submit a request (within allowance, deadline and the open switch), and the private calendar link.

**Calendar export**: `/api/calendar/<private token>` is an iCalendar feed of a participant's published shifts
plus the academic time they attend. Google, Apple and Outlook can subscribe to it.

## How it is put together

| File | What it does |
|---|---|
| `src/lib/crud.ts`, `src/lib/entities.tsx` | Each simple screen is described once (fields, columns, validation); the list, form and save/delete are generic |
| `src/components/entity-pages.tsx`, `entity-form.tsx`, `children.tsx` | The generic list and form, and the child tables edited on a parent's page |
| `src/app/(admin)/intervals/[id]/page.tsx` | The interval hub |
| `src/lib/compile.ts` | Database -> engine input + the uniform compiled-rules list. (`datamodel/compile_interval.py` is an older Python version kept for the data-model test; it does not know backup, site split or personal academic days) |
| `src/app/(admin)/assignments/`, `src/app/assignment-actions.ts`, `src/components/institutions-form.tsx` | The participant list and the per-participant, per-interval page |
| `src/lib/ai.ts`, `src/lib/assist.ts`, `src/lib/rule-interpreter.ts` | The Anthropic API call (forced tool use), and the three readers: rules, backup rules, special-day changes; each falls back to the keyword reader |
| `src/lib/backup-rules.ts`, `src/components/backup-rules-*.tsx`, `src/app/backup-actions.ts` | Backup shift rules |
| `src/components/special-day-form.tsx`, `src/app/special-day-actions.ts` | Special staffing days |
| `src/app/prior-actions.ts` | Shifts entered for the previous interval |
| `src/lib/auth.ts` | Who is signed in: the signed session cookie and the checks every page and action starts with |
| `src/lib/accounts.ts`, `passwords.ts` | Sign-in, the guessing limit, one-time links, who may change whom, password storage |
| `src/lib/program-setup.ts` | First-time setup, what an empty program starts with, the demo program, start over |
| `src/app/account-actions.ts`, `src/components/access-manager.tsx`, `auth-forms.tsx` | The sign-in, join, setup, account and access screens |
| `scripts/migrate.mjs` | Brings a database up to date without removing anything; runs at every start of a hosted site |
| `../Dockerfile`, `../render.yaml`, `../DEPLOY.md` | The hosted build, the hosting service's setup file, and the step-by-step guide |
| `src/lib/engine.ts` | Starts the engine as a background process, follows it, imports its result, cancels it. The one file to change when the engine moves to its own server |
| `src/lib/schedules.ts` | The publishing rules (what blocks it, what needs a tick), publish and unpublish |
| `src/app/(admin)/intervals/[id]/schedules/[sid]/` | The review page, the run-status address the page polls, and the spreadsheet download |
| `src/components/run-progress.tsx` | The live progress display |
| `src/components/schedule-calendar.tsx`, `src/app/print/schedules/[sid]/` | The calendar view, and its printable page |
| `src/lib/rule-templates.json`, `rule-templates.ts`, `rules.ts`, `src/components/rule-form.tsx` | The rule template library and the one rule form generated from it |
| `src/lib/rule-interpreter.ts`, `src/components/assist-panel.tsx` | Plain English -> proposed rule |
| `src/lib/domain.ts` | Academic sessions, allowance counting, conflict notes |
| `src/lib/calendar.ts` | The .ics feed |
| `prisma/migrations/` | `0001_init` (tables), `0002_constraints` (no overlapping assignments or intervals, one published schedule per interval, ...) and `0003_schedule_runs` (engine runs: one at a time per interval, only a finished schedule can be published) and `0004_accounts` (passwords, one-time links, sign-in limits) and `0005_assignments_backup` (assignments per interval, site shares and date windows, required time off, personal academic days, backup shifts, previous-interval shifts; clears old per-assignment counts) and `0006_days_in_a_row` (adds the "Max days worked in a row" rule, 6, to existing programs) |

## Tests

Everything signs in through the real sign-in form.

    npm run db:reset && npm run build && npm start         # then, in another shell:
    node e2e/smoke.cjs            # every list, edit and new page loads without browser errors
    node e2e/flows.cjs            # 51 checks in a real browser (Playwright): the input screens
    npm run db:reset && node e2e/schedule.cjs          # 57 checks: generate -> review (including the calendar views) -> publish, with the real engine (about 3 minutes)
    npm run db:reset && node e2e/assignments.cjs       # 56 checks: assignments, academic exceptions, special days, backup, previous interval, optimize (about 3 minutes)
    npm run db:reset && npx tsx tests/engine-check.ts  # 46 checks on the engine runner, including optimize, no browser needed
    npm run db:reset && npx tsx tests/hard-rules-check.ts  # 25 checks: role grid, institutions and 6 days in a row, both solvers and optimize, the pre-run check, the review page's causes (about 4 minutes)
    npm run db:reset && npx tsx tests/optional-places-check.ts  # 11 checks: shifts that can take 1-2 and a 0-1 Dugout used to reach everyone's minimum (about 2 minutes)
    npm run db:reset && npx tsx tests/grid-property-check.ts  # 150 random role grids (with roles sharing levels): what the engine is told equals the grid and institutions, for every person and shift
    npx tsx tests/ai-check.ts                          # 15 checks on the Claude readers against a stand-in API server (and the fallback)
    npm run db:reset && npx tsx tests/accounts-check.ts  # 61 checks on sign-in, links, limits, setup and start over, no browser needed
    npm run db:reset && python tests/verify_stored.py  # the stored schedule passes the independent rule check

    # a new hosted site, from first visit to start over (61 checks, about 2 minutes). Needs an EMPTY database:
    npm run db:reset -- --empty && SETUP_KEY=a-long-setup-key-123 npm start
    SETUP_KEY=a-long-setup-key-123 node e2e/accounts.cjs

`accounts.cjs` covers: a new site sending its first visitor to setup; setup refused without the key and closed
after use; security headers; nothing reachable signed out; the demo people unable to sign in; invite links
(shown once, single use, weak passwords refused); what residents and chiefs cannot open; the lock after five
wrong passwords and the reset that clears it; switching a sign-in off signing the person out at once; a second
administrator; not being able to demote or remove yourself; a password change signing other devices out; forged
sign-in cookies refused; a schedule generated and published by the engine; and start over.

`accounts-check.ts` covers the same rules directly, plus what a browser cannot easily show: expired links, two
people using one link or submitting setup at the same moment, the lock ending, the limit per network address,
an over-long email, the last-administrator rule, the database refusing a mixed-case email, and start over
leaving a second program untouched.

`flows.cjs` covers: access by role; the hub tabs; allowance counted per day; resident submit, stop at the
allowance, admin approve and turn off; overlapping assignments and intervals refused; end before start;
end time across midnight; area must match institution; admin override; conflicts shown on lists; archive
instead of delete and restore; rule form validation; plain-English flow including "nothing saved until
confirmed", edit before confirm, and the custom fallback; system rules not deletable; approval setting.

`schedule.cjs` covers: the generate panel and its warnings; a run in progress, with a second one refused; cancel;
the result opening by itself; the summary accounting for every shift; both grids showing each filled shift once;
vacation kept clear; every person inside their contract range; goals, per-person figures and the spreadsheet; the
calendar (28 day boxes, every filled shift and backup day named once, each hospital's view holding only its own
shifts and the two adding up to the combined view, the printable page with all three views);
residents unable to see drafts, the review page or run status; a schedule flagged after its inputs change and
publishing refused without the tick; the resident's page and calendar link carrying exactly the published
shifts; a newer schedule replacing the published one; unpublish; discard; and inputs that cannot be staffed,
shown with open shifts and reasons.

`engine-check.ts` covers the same runner without a browser, plus the failure cases: Python missing, engine folder
missing, the engine stopping with an error (reason shown, its output kept, nothing saved), a run whose process has
died, a second published schedule refused by the database, and the next interval inheriting exactly the published
schedule's last week (same people, same start and end times).

`assignments.cjs` covers: the participant list (role filter, sorting, search); assign and remove; split percentages
that do not add to 100% and dates outside the interval refused; adjustments; required time off with a time window;
no nights and notes; personal academic days; each of these in the compiled rules; a date an academic day does not
happen; Replace listing inactive shifts and refusing an empty day; Modify read into lines and saved; backup rules
read from words, saved and reflected in the role grid; previous-interval shifts entered and pasted, a bad paste
refused whole; backup days on the review page; and Optimize producing a new draft.

`verify_stored.py` reads a generated schedule back out of the database and runs the engine's independent checker on
those rows alone: no hard rule broken, every goal score in the report reproduced, every stored time equal to the
shift it stands for; and the stored backup days pass the separate backup checker. It starts the run in one process and collects it from another, which is what a web server
restart looks like to the engine. It passes with both engines (`ENGINE_BACKEND=highs` and `cpsat`).

## What has and has not been checked

Checked here: `prisma validate` and `prisma generate` (Prisma 7.10.1) pass; type-check and production build
pass; every suite above passes against a production build. The hosted layout was also assembled by hand,
following the steps in `Dockerfile` (site built with no settings file; engine in its own Python environment;
started as an unprivileged user with only the hosting service's settings; brand-new database), and
`accounts.cjs` passes against that.

Not checked:

* **The Docker build itself and a real deployment.** Docker's base images could not be downloaded here, and
  nothing has been deployed to a hosting service. See `DEPLOY.md`.
* **The migration SQL has not been through Prisma's migration engine**, whose binary could not be downloaded
  here. The migrations are plain SQL, applied by `scripts/migrate.mjs`, which records them in the table and form
  Prisma's tool uses; whether Prisma's tool then accepts that record has not been tried. The resulting tables
  were compared column by column with the schema.
* **HTTPS and a real proxy.** The sign-in cookie is marked secure when the site is reached over HTTPS; that
  path, and how the hosting service reports a visitor's network address, were not exercised here.
* **Generating has only been tried on the demo program** from the app (18 people, 265 shifts, about 45 seconds on
  the quick setting). The engine alone has been tested on programs of 50-70 residents and about 1,000 shifts,
  which took about 5 minutes and used about 400 MB of memory; that size has not been run through the app.
* **The engine and the web app must be on the same machine, and there must be exactly one server.** If the
  server is replaced while the engine is running (a deploy or restart), the run is lost and the site says so.
* No security review, audit or penetration test has been done.
* **Claude itself has not been called from here**: the Anthropic API was not reachable. The calls were tested against a
  stand-in server that answers the way the API documents (`tests/ai-check.ts`), and every screen was tested with the
  keyword reader. The first real test is on your site once the key is added.
* The calendar feed has been checked for format and content, not subscribed to from Google or Apple.

## Not built yet

* The site sending email: invitations, password resets and "your schedule is published" all go by hand today.
* Two-step sign-in, and self-service "forgot my password".
* Changing a generated schedule by hand (swap two people, fill an open shift, move a shift).
* More than one program per site, self-service sign-up for other programs, and payment.
* A screen for reading the audit log; replacing a calendar link that has been shared by mistake; exporting or
  deleting one person's data.
* The rules marked "stored only" are still not enforced by the engine; the review page says so.
* An AI-written explanation of a schedule (why something was or was not possible, using the admin's notes). The notes are
  stored and shown with the compiled rules, ready for it.
* Backup and the clinical schedule are decided one after the other, not together, so a clinical schedule is never
  changed to make backup easier.
* Bulk tools (import participants, copy an interval's setup, yearly role promotion).
