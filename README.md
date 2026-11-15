# Cadence solver prototype (v3: config-driven, scaled, confirmed rules)

The solver decides nothing about the program. Shift start times, shift lengths, headcounts, academic time,
chief time, category names and every rule limit come from an admin configuration file. It handles 30+ shifts a
day and is tested on 8h, 10h, 12h and mixed-length blocks with academic time that changes length and time of day
every week.

## What is in this package

| Folder | What it is |
|---|---|
| `cadence/`, `run.py`, `tests/` | The scheduling engine (this file describes it) |
| `datamodel/` | The database design, its constraints, the rule template library and the Python bridge to the engine. Start with `datamodel/DATA_MODEL.md` |
| `web/` | The admin and resident web app (Next.js + PostgreSQL). Start with `web/README.md` |
| `DEPLOY.md`, `Dockerfile`, `render.yaml` | Putting it online: the step-by-step guide, the hosted build, and the hosting service's setup file |

## Run it

    python run.py tests/configs/8h+12h.json --out out --seconds 600   # schedule one block from a config
    python run_tests.py my-test 8,12 32 5                             # generate + solve a random test block
    python -m tests.test_validator                                    # the validator catches injected rule breaks
    python -m tests.test_rules                                        # nights exception + academic overlap setting
    python -m tests.test_model_vs_validator                           # exact model and validator agree
    cat matrix.txt | xargs -L 1 python run_tests.py                   # re-run the whole test matrix below

Needs Python 3.10+, NumPy and SciPy (`pip install -r requirements.txt`). `--backend cpsat` uses OR-Tools CP-SAT if installed (see "Engine").

### How the web app calls it (14 Nov 2026)

    python run.py inputs.json --out work --result work/result.json --progress work/progress.json --seconds 240 --polish-seconds 60

* `--result` writes everything about the schedule as one JSON file: every shift with who is on it, open shifts
  each with the reasons nobody else can take them, the independent checker's findings, each goal's score,
  per-person figures (shifts, hours, nights, weekend shifts, most hours in 7 days, request days not granted),
  the capacity pre-check's messages, and which engine ran. Every figure in it comes from the independent checker
  and the clock times, not from the solver's model.
* `--progress` is a small JSON file rewritten at the start of each phase (reading, capacity check, first
  schedule, swaps, each goal in turn, rule check), so a caller can show what the engine is doing.
* Both are written to a temporary file and renamed, so a reader never sees half a file. The result is written
  last.

The engine still shares no code and no database access with the web app: one JSON file in, one out.

## What the admin configuration contains

Everything below is input. `tests/configs/*.json` are complete examples.

| Key | Meaning |
|---|---|
| `shift_templates` | name, site, pod, category, start time, hours (any length, to the minute), headcount, minimum PGY, and which weekdays or specific dates it runs. Date-specific templates are how special staffing days are expressed. `counts_as_previous_day` marks a night that starts after midnight |
| `academic_time` | dated sessions: day, start, hours, optional protected buffer before/after, optional PGY levels that attend, and `if_shift_overlaps`: `"blocked"` or `"excused"` (see below). `academic_if_shift_overlaps` sets a program-wide default |
| `chief_time` | weekly windows in which residents flagged `chief_days` cannot be scheduled |
| `category_order`, `night_categories`, `balance_groups`, `pod_pairs` | the clockwise rotation order, which categories count as nights, what gets balanced |
| `residents` | PGY, contract min/max shifts, vacation, mandatory days off, weighted requests off, sites |
| `history` | shifts worked in the last 7 days of the previous block (carried across the boundary) |
| `rules` | weekly hours cap, rest ratio, night cap, night-run limits, 45% night share, balance tolerances |

## Added for the data model (13 Nov 2026)

Four optional inputs, so that rules kept in the web app's database can reach the engine. See `datamodel/`.

| Key | Meaning |
|---|---|
| `residents[].unavailable` | hard "cannot work" rules: any mix of date range, weekdays, time-of-day window, shift categories, sites |
| `residents[].only_shifts` + `shift_templates[].ref` | the only shift templates a person may work |
| `rules.min_rest_hours` | rest between shifts is never less than this, whatever the shift length |
| `academic_time[].excused`, `.also_attend` | per-person exceptions to who attends a session |

The three test suites below pass with these in place. The test matrix further down was run before they were
added and has not been re-run; they do nothing unless a configuration uses them.

## Rules confirmed on 13 Nov 2026

1. **Balance tolerance of one shift.** Day/evening/night counts within 1 shift of a resident's fair share, and pod
   counts within 1 of each other, count as balanced (`balance_tolerance_shifts`, `pod_tolerance_shifts`).
2. **Shifts that overlap academic time are an admin setting**, per session or program-wide:
   * `"blocked"`: residents who attend cannot be given a shift that overlaps the session (or its protected buffer).
     The admin is expected to define that day's shifts around it; any shift left overlapping is reported by the
     pre-check as unfillable.
   * `"excused"`: overlapping shifts are staffed normally and whoever works one is excused from that session.
   Either way, a session a resident actually attends counts as duty for the 24-hours-off rule and not toward the
   60 clinical hours. Residents on vacation that day are excused.
3. **One shift per resident per day, except a series of nights.** A shift counts toward the day it belongs to. A
   night belongs to the evening it starts; a night that starts just after midnight belongs to the previous day.
   So back-to-back nights are always one per day, even when one starts at 00:30 and the next at 22:00 on the same
   calendar date, and they count as one run of nights. A day shift plus the overnight belonging to that same day
   is still refused. Vacation, mandatory days off and requests off go by the calendar date a shift starts on.

## How it works

1. **Pre-check** (milliseconds): supply vs demand overall, by hours, per PGY tier, nights, per day, per week, per shift.
2. **Greedy warm start**: nights first as single runs, then day by day to the least-loaded eligible resident.
3. **Swap polish** (plain code): single-day trades, hand-offs, multi-day schedule swaps and two-step chains to
   fill open shifts. A move is kept only if the goals improve in strict priority order and every hard rule holds.
4. **Exact staged optimisation**: the model is one block of constraints per resident, tied together only by
   coverage rows with an "open" slack per shift.
   * Small programs: the whole program in one exact solve per goal, which gives proofs of optimality.
   * Large programs: the exact solver is handed a neighbourhood (some residents x some days) with everything
     else fixed, a few hundred to a couple of thousand decisions at a time, goal by goal. A move may never
     worsen an earlier goal.
5. **Independent validator**: plain loops over actual clock times, no shared code with the model. Every move the
   exact solver proposes is also re-checked by it before being accepted.

Hard rules: coverage and PGY eligibility, one shift per day (with the nights exception above), rest >= length of
the prior shift, weekly clinical-hours cap on every rolling 7x24h window, one 24h period free of shifts and attended
academic time in every 7 days, night cap and number of night runs, vacation, mandatory days off, chief time,
academic time per the admin setting, contract maximum. All carried across the block boundary through `history`.

## Test results

Thirteen generated blocks, 30-38 shifts every day: two sites, four pods, a PGY-2+ restricted pod, two chiefs,
vacations, requests, prior-block history, and a weekly academic session of 2-4 hours whose start time and length
change every week. Contract maximums add up to about 4% more than the shifts to fill, except three stress blocks
(+2.7%, +1.1%, 0%) and one deliberately understaffed block.

| Scenario | Residents | Shifts (per day) | Staffing margin | Open | Hard violations | Under contract min | Peak 7-day hours | Backward rotations | Day/evening/night balance | Night runs too close | Nights into vacation | Night share over limit | Pod balance | Isolated days off | Extra / over-long night runs | Requests off missed | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8h | 50 | 936 (32-34) | +4.5% | 0 | 0 | 0 | 56 | 0 | 0 | 1 | 0 | 0 | 0 | 70 | 30 | 21 | 5.0 min |
| 10h | 62 | 908 (31-33) | +4.4% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 26 | 1 | 4.7 min |
| 12h | 69 | 880 (30-32) | +5.0% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 45 | 17 | 5.0 min |
| 8h+10h | 58 | 964 (33-35) | +4.3% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 26 | 29 | 12 | 5.0 min |
| 8h+12h | 63 | 936 (32-34) | +4.2% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 18 | 0 | 4.8 min |
| 10h+12h | 71 | 992 (34-36) | +4.0% | 0 | 0 | 0 | 60 | 0 | 0 | 1 | 0 | 0 | 0 | 4 | 22 | 14 | 5.0 min |
| 8h+10h+12h | 66 | 1048 (36-38) | +4.5% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 13 | 24 | 13 | 5.1 min |
| tight-8h+10h+12h | 59 | 936 (32-34) | +2.7% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 24 | 0 | 5.0 min |
| margin-1pct | 59 | 936 (32-34) | +1.1% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 17 | 18 | 2 | 4.7 min |
| margin-0pct | 60 | 936 (32-34) | +0.0% | 0 | 0 | 0 | 60 | 0 | 0 | 1 | 0 | 0 | 2 | 22 | 28 | 20 | 5.1 min |
| midnight-overnights-8h | 49 | 936 (32-34) | +5.1% | 0 | 0 | 0 | 56 | 0 | 0 | 1 | 0 | 0 | 0 | 66 | 16 | 7 | 4.8 min |
| excused-late-8h+10h+12h | 62 | 964 (33-35) | +4.6% | 0 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 23 | 21 | 0 | 5.0 min |
| understaffed-8h+12h | 59 | 936 (32-34) | -3.4% | 32 | 0 | 0 | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 47 | 21 | 8 | 5.2 min |

Columns from "Backward rotations" onward are soft-goal scores recomputed by the validator; lower is better and 0
means fully met. Each run was allowed 60 s of polish and 240 s of exact optimisation on one CPU core.

* `midnight-overnights-8h`: half the night lines start at 00:00 and the rest late evening, academic time "blocked".
  35 resident-days have two nights starting on the same calendar date, all accepted.
* `excused-late-8h+10h+12h`: overnights start between 00:00 and 01:00, overlapping shifts are left in place and
  academic time is "excused". Residents were excused by a shift 87 times; 30 resident-days have two
  nights starting on the same date.

Reading the table:

* **Every scenario: zero hard-rule violations.** Peak hours in any rolling 7 days never exceed 60.
* **Every adequately staffed scenario is fully covered**, including the block with a 0% margin, where every
  resident has to work exactly their contract maximum.
* Backward rotations, day/evening/night balance, nights into vacation and the 45% night share are zero in every block. Night runs less than 7 days apart is zero in nine blocks and 1 in the other four; pod balance is zero in twelve blocks and 2 in the zero-margin block. A zero is optimal by definition.
* The last three columns (isolated days off, one run of nights per person, requests off) are improved but
  **not proven optimal**; they are the lowest priorities and are optimised last, under everything above them.
* The understaffed scenario shows the fallback: the pre-check says in under a second that contracts cannot cover
  the block, and the solver still returns a rule-clean schedule with 32 shifts open, each with reasons.
  32 is exactly the capacity shortfall (936 shifts against 904 of contract capacity), so no schedule could leave fewer.

`results/` has, per scenario: the schedule grid (HTML), the schedule (CSV) and the full run report (TXT).

## Checks on the checker

* `tests.test_validator`: 12 deliberately injected rule breaks, each caught.
* `tests.test_rules`: the nights exception and both academic settings behave as described above.
* `tests.test_model_vs_validator`: 5,840 random personal schedules (most of them illegal) across three
  configurations; the exact model and the validator agree on every one, both on legality and on every soft score.
  This check found one discrepancy, now fixed: the model scored a backward rotation by the size of the step
  (night to day = 3) while the validator counted it once. Both now count each backward step once. Earlier results
  were unaffected because backward rotations were zero in every block.
* During the test runs the validator rejected none of the moves proposed by the exact solver.

## Engine

The spec calls for OR-Tools CP-SAT. Every result in the table above used **HiGHS**, an exact branch-and-cut
solver bundled with SciPy and reached through a private SciPy module, because OR-Tools could not be installed
when those runs were made.

**CP-SAT first ran on 14 Nov 2026** (OR-Tools 9.15), unchanged from how it was written:

* the demo block from the web app (18 participants, 265 shifts), whole program at once (`--strategy full`):
  zero hard-rule violations, full coverage, every goal improved within its time limit;
* the 8-hour test block (50 residents, 936 shifts) with neighbourhoods (`--strategy lns`): zero hard-rule
  violations, full coverage.

The web app's tests have since run it many more times on the demo block, and every run they checked had zero
hard-rule violations. That is still not a benchmark. The 13-block matrix has not been re-run on CP-SAT, and CP-SAT has not been
tried on a 30-shift/day program in one piece. `python run.py <config> --backend cpsat` selects it.

## Smaller decisions still open

1. **Default when the admin sets nothing for academic overlap** is `"blocked"`.
2. **A night after midnight is recognised automatically** when its category is a night category and it starts
   before noon; `counts_as_previous_day` overrides that per template.
3. **A non-night shift later on the day a night ends** (night ends 07:00, swing starts 17:00) is allowed by the hard
   rules if the rest requirement is met. It is penalised as a backward rotation, and was zero in every test.
4. **Contract minimum** is a slack, second only to coverage, so an over-staffed block still returns a schedule.
5. **Fair share** for balance is proportional to each resident's contract maximum.
6. **Shift categories** (day/evening/swing/night) are tags the admin puts on each template; the solver does not
   infer them from clock times.

## Not built yet

* The test matrix on CP-SAT, and assumption-based infeasibility cores; open shifts are explained by plain code instead.
* Any separate weekly cap on total hours (clinical plus academic); only the clinical-hours cap is enforced.
* Richer staffing mixes ("at least one PGY-3 among the night team"), must/must-not work together, weekend fairness.
* A multi-block driver carrying cumulative night/weekend counts through the year.
* Changing a generated schedule by hand in the web app. (Starting the engine from the app, reviewing the result
  and publishing it are built: see `web/README.md`.)
