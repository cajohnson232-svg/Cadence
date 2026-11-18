-- Rules the Prisma schema cannot express. Apply as a hand-written migration after
-- the tables exist. These back up the form validation; they do not replace it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A participant's assignments must not overlap.
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_no_overlap"
  EXCLUDE USING gist ("participantId" WITH =, daterange("startDate", "endDate", '[]') WITH &&);

-- Scheduling periods of one program must not overlap.
ALTER TABLE "Interval" ADD CONSTRAINT "Interval_no_overlap"
  EXCLUDE USING gist ("programId" WITH =, daterange("startDate", "endDate", '[]') WITH &&);

-- At most one published schedule per interval.
CREATE UNIQUE INDEX "Schedule_one_published" ON "Schedule" ("intervalId") WHERE status = 'PUBLISHED';

-- One engine run at a time per interval, and only a finished schedule can be published.
CREATE UNIQUE INDEX "Schedule_one_active_run" ON "Schedule" ("intervalId") WHERE "runStatus" IN ('QUEUED', 'RUNNING');
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_published_is_done" CHECK (status <> 'PUBLISHED' OR "runStatus" = 'DONE');

-- End after start.
ALTER TABLE "Interval"   ADD CONSTRAINT "Interval_dates"   CHECK ("endDate" >= "startDate");
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_dates" CHECK ("endDate" >= "startDate");
ALTER TABLE "TimeOff"    ADD CONSTRAINT "TimeOff_dates"    CHECK ("endDate" >= "startDate");
ALTER TABLE "AcademicDay" ADD CONSTRAINT "AcademicDay_dates"
  CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_times" CHECK ("endsAt" > "startsAt");

-- Times of day, lengths and headcounts.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_time" CHECK ("startMinute" BETWEEN 0 AND 1439 AND "durationMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_headcount" CHECK ("minParticipants" >= 0 AND "maxParticipants" >= "minParticipants");
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_days" CHECK ("daysOfWeek" <@ ARRAY[0,1,2,3,4,5,6]);
ALTER TABLE "ShiftRole" ADD CONSTRAINT "ShiftRole_count" CHECK ("requiredCount" >= 0 AND ("eligible" OR "requiredCount" = 0));
ALTER TABLE "AcademicDay" ADD CONSTRAINT "AcademicDay_time"
  CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "startMinute" BETWEEN 0 AND 1439 AND "durationMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_counts" CHECK ("minShifts" >= 0 AND "maxShifts" >= "minShifts");
ALTER TABLE "Role" ADD CONSTRAINT "Role_counts"
  CHECK ("defaultMinShifts" IS NULL OR "defaultMaxShifts" IS NULL OR "defaultMaxShifts" >= "defaultMinShifts");

-- Special staffing lines: change/remove need the normal shift; a brand-new shift needs its own details.
ALTER TABLE "SpecialStaffingShift" ADD CONSTRAINT "SpecialStaffingShift_shape" CHECK (
  ("action" IN ('CHANGE', 'REMOVE') AND "shiftId" IS NOT NULL)
  OR ("action" = 'ADD' AND ("shiftId" IS NOT NULL
        OR ("name" IS NOT NULL AND "categoryId" IS NOT NULL AND "startMinute" IS NOT NULL AND "durationMinutes" IS NOT NULL))));

-- Requests carry a priority; vacation does not.
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_priority" CHECK (
  CASE WHEN "kind" = 'VACATION' THEN "priority" IS NULL AND NOT "mandatory" ELSE "priority" IS NOT NULL OR "mandatory" END);
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_interval" CHECK ("kind" = 'VACATION' OR "intervalId" IS NOT NULL);

-- A rule points at exactly the thing its scope names; soft rules have a weight of 1-10.
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_scope_target" CHECK (
  ("scope" = 'PROGRAM'     AND "institutionId" IS NULL AND "roleId" IS NULL AND "participantId" IS NULL) OR
  ("scope" = 'INSTITUTION' AND "institutionId" IS NOT NULL AND "roleId" IS NULL AND "participantId" IS NULL) OR
  ("scope" = 'ROLE'        AND "roleId" IS NOT NULL AND "institutionId" IS NULL AND "participantId" IS NULL) OR
  ("scope" = 'PARTICIPANT' AND "participantId" IS NOT NULL AND "institutionId" IS NULL AND "roleId" IS NULL));
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_weight" CHECK (
  ("level" = 'HARD' AND "weight" IS NULL AND "priority" IS NULL) OR ("level" = 'SOFT' AND "weight" BETWEEN 1 AND 10));
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_dates" CHECK ("activeFrom" IS NULL OR "activeTo" IS NULL OR "activeTo" >= "activeFrom");

-- An email address is stored in lower case, so "Pat@x.org" and "pat@x.org" cannot be two accounts.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK (email = lower(email));

-- 17 Nov 2026: split between institutions, required time off windows, entered prior-block shifts.
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_share_range" CHECK ("sharePercent" IS NULL OR ("sharePercent" BETWEEN 0 AND 100));
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_dates_order" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_window_range" CHECK (("startMinute" IS NULL) = ("endMinute" IS NULL) AND ("startMinute" IS NULL OR ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 0 AND 1440 AND "startMinute" <> "endMinute")));
ALTER TABLE "PriorShift" ADD CONSTRAINT "PriorShift_times" CHECK ("startMinute" BETWEEN 0 AND 1439 AND "durationMinutes" BETWEEN 1 AND 2880);
