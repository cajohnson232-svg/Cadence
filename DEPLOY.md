# Putting Cadence online

This takes Cadence from this folder to a website with its own address, where people sign in by invitation.
No programming is needed. You create two accounts, click through two setup screens, and type one key.

**Read "Before real people's data goes in" at the end before you invite anyone.**

## What you end up with

* A website at an address like `https://cadence-xxxx.onrender.com` (your own domain can come later).
* The scheduling engine running inside the same server, so "Generate schedule" works.
* A database that the hosting service keeps backed up.
* Nobody can get in unless an administrator invites them. The first administrator is you.

## What it costs

The setup file in this folder (`render.yaml`) asks Render for:

| What | Render's name for it | Listed price (render.com/pricing, 15 Nov 2026) |
|---|---|---|
| The server for the site and the engine: 1 CPU, 2 GB memory | web service, plan `1c-2g` | $25 a month |
| The database | Postgres, plan `0.1c-256mb` | $6 a month, plus storage at $0.30 per GB |
| The account itself | "Hobby" workspace | $0 |

About **$31 a month**. Prices change, so check Render's pricing page before you start. You can delete
everything at any time and the charges stop.

Why not the cheaper $7 server: it has 512 MB of memory. While the engine builds a schedule it needs 250 MB for
the demo program and about 400 MB for a 66-resident program (measured), on top of the website itself.

## Part 1. Put the code on GitHub

Hosting services install a site from a GitHub repository, which is a private online folder for code.

First create a free account at github.com if you do not have one. Then use one of these two ways.

**Way A: have Claude upload it.**

1. On github.com create a **new repository**. Name it `cadence`, choose **Private**, and do not tick any of
   the "add a README / .gitignore / license" boxes. It must start empty.
2. In Claude, connect GitHub under Settings > Connectors and allow access to that repository.
3. Tell Claude the repository's name (for example `yourname/cadence`) and ask it to upload the project.
   This is also the easiest way to get later changes online.

**Way B: GitHub Desktop** (a free app from GitHub; no typing of commands).

1. Unzip the project.
2. In GitHub Desktop choose File > Add local repository and pick the unzipped folder. It will say the folder is
   not a repository yet and offer to create one there: accept.
3. Commit everything, then press **Publish repository**. Name it `cadence` and keep "private" ticked. (Do not
   create the repository on github.com first; publishing creates it.)

Whichever way, when you open the repository on github.com you should see `Dockerfile`, `render.yaml`,
`DEPLOY.md`, and the folders `cadence` and `web` at the top level. If they are inside another folder, Render
will not find them.

The repository must never contain a file called `.env`. The project's `.gitignore` already keeps it out.

## Part 2. Create the site on Render

1. Create an account at render.com and add a payment method.
2. In the Render dashboard choose **New**, then **Blueprint**.
3. Connect your GitHub account when asked, and pick the `cadence` repository.
4. Render reads `render.yaml` and shows what it will create: a web service called `cadence` and a database
   called `cadence-db`. Confirm.
5. Wait. The first build takes several minutes: it installs the website's packages and the engine's Python
   packages, and builds the site. The service's **Logs** page shows progress. It is finished when the log
   shows `migrate: database is up to date` followed by `Ready`, and the service is marked live.

If the build stops with an error, copy the last 30 lines of the log and give them to whoever is helping you
(Claude can read them). **This build file has not been run on Render yet**: see "What was and was not tested".

## Part 3. First-time setup

1. In Render, open the `cadence` web service, go to **Environment**, and reveal the value of `SETUP_KEY`.
   Copy it. Render generated it; it proves the site is yours.
2. Open your site's address (shown at the top of the service's page). It takes you to **Set up Cadence**.
3. Paste the setup key, enter your name and email, and choose a password of at least 10 characters.
4. Choose what to start with:
   * **The demo program**: 18 made-up people, two hospitals, one interval ready to schedule. Best for a first
     look. The demo people cannot sign in; only you can.
   * **An empty program**: only the standard rules, shift categories and PGY roles.
5. Press **Set up this site**. You are signed in as the administrator, and setup closes for good.

To try it: Intervals > Block 7 > Generate schedule > Quick. A schedule appears in about a minute.

## Part 4. Invite people

Go to **Sign-in & access** (bottom of the left menu; administrators only).

* For a participant: press **Give a sign-in and make invite link** next to their name. They need an email
  address on their participant record first.
* For a coordinator, program director or chief who is not a participant: use the form at the bottom.

Each time, a one-time link appears. **Send it to that person yourself**, by email or text. The site does not
send email. The link works once, for 7 days, and lets them choose their own password. If it is lost, make a
new one; the old one stops working.

Forgotten password: press **Make reset link** for that person and send it to them. It works for 24 hours.

Someone leaves: **Switch sign-in off** (they are signed out at once; you can undo it) or **Remove**.

Add a second administrator early, so that one person being away does not lock the program out.

## Part 5. From the demo to your own program

When you have seen enough of the demo: **Program settings > Start over with an empty program**. Type the
program's name to confirm. It removes everything in the program and cannot be undone. Administrators keep
their sign-in; everyone else's access is removed.

Then enter your own, in this order: Institutions, Roles, Participants, Shift categories, Shifts, an Interval,
Assignments, then time off and rules.

## Later

**Changing the site.** Whenever the GitHub repository changes, Render rebuilds and switches to the new version
by itself, and brings the database up to date as it starts. Do not let this happen while a schedule is being
generated: the run is lost (the site says so) and has to be started again.

**Backups.** Render keeps paid databases recoverable to any moment in the past 3 days on the free "Hobby"
workspace, and 7 days on the $25 "Pro" workspace. You can also export a copy from the database's Recovery page;
Render keeps an export for 7 days, so download any you want to keep. Do one practice restore before you rely on it.

**Your own address.** In the web service's Settings, add a custom domain and follow Render's instructions for
your domain provider. Nothing in the app needs changing.

**If you forget your own password** and there is no other administrator, nobody in the app can reset it. This is
why a second administrator matters.

**Stopping.** Delete the web service and the database in Render. Export the database first if you want the data.

## What was and was not tested

Tested here, on a Linux machine, following the same steps the build file lists:

* The site built with no settings file present, the engine's Python packages installed into their own
  environment, and the whole thing started as an unprivileged user with only the four settings Render supplies,
  against a brand-new empty database.
* On that, a browser test walked through everything in Parts 3 to 5: setup refused without the key, setup with
  it, invitations, refused weak passwords, the lock after five wrong passwords, reset links, switching sign-in
  off, a chief's limits, a second administrator, changing a password, forged sign-in cookies, generating and
  publishing a schedule with the engine, and starting over.

Not tested:

* **The Docker build itself, and Render.** The machine this was built on could not download the base images, and
  nothing has been deployed to Render from here. The first real build may need a correction to `Dockerfile` or
  `render.yaml`. Field names and plan names in `render.yaml` were checked against Render's Blueprint reference
  on 15 Nov 2026.
* Running over HTTPS behind Render's network. In particular, the limit on wrong sign-in attempts per network
  address depends on how Render reports a visitor's address, which could not be checked here. The limit per
  email address does not depend on it.
* How fast the engine is on Render's 1-CPU server. The time settings (quick, standard, thorough) were tuned on
  a different machine; on a slower one the same setting gives a less polished schedule, never an invalid one.
* Browsers other than Chrome's engine.

## Before real people's data goes in

* **Ask your institution.** A residency's schedule holds names, email addresses and where people will be and
  when. Your GME office or IT security may have rules about putting that in outside software. This has not
  been through any security review or audit.
* **Not built yet:** the site sending email (invitations, published-schedule notices), two-step sign-in,
  self-service "forgot my password", a screen for reading the audit log, exporting or deleting one person's
  data on request, terms of use and a privacy notice, payment, and more than one program per site.
* **One server.** If it restarts while a schedule is being generated, that run is lost. If the service is ever
  set to more than one instance, generating stops working properly; leave it at one.
* **A wrong-password lock can be used against someone.** Anyone who knows a person's email address can lock
  their sign-in for 15 minutes at a time by guessing wrong five times. It protects the password; it is a nuisance
  if abused.
* **Calendar links are secrets.** Anyone who has a person's calendar link can see that person's shifts without
  signing in. There is no button yet to replace a link that has been shared by mistake.
