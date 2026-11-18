-- 17 Nov 2026: assignments made per participant and interval; split between institutions; required time off;
-- no nights; personal academic days; backup shifts; how the previous interval ended; special-day change text.
-- Additive, except: assignments now take their shift counts from the role (existing counts are cleared,
-- as asked), and eligible-shift lists on assignments are no longer used (kept, not deleted).

-- AlterEnum
ALTER TYPE "TimeOffKind" ADD VALUE 'REQUIRED_OFF';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN "intervalId" TEXT,
ADD COLUMN "noNights" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "minShifts" DROP NOT NULL,
ALTER COLUMN "maxShifts" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AssignmentInstitution" ADD COLUMN "sharePercent" INTEGER,
ADD COLUMN "startDate" DATE,
ADD COLUMN "endDate" DATE;

-- AlterTable
ALTER TABLE "TimeOff" ADD COLUMN "startMinute" INTEGER,
ADD COLUMN "endMinute" INTEGER;

-- AlterTable
ALTER TABLE "AcademicDay" ADD COLUMN "participantId" TEXT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN "isBackup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "backupRules" JSONB,
ADD COLUMN "backupRulesText" TEXT;

-- AlterTable
ALTER TABLE "SpecialStaffingDay" ADD COLUMN "changeText" TEXT;

-- AlterTable
ALTER TABLE "ScheduledShift" ADD COLUMN "backup" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PriorShift" (
    "id" TEXT NOT NULL,
    "intervalId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "categoryId" TEXT NOT NULL,
    "shiftId" TEXT,

    CONSTRAINT "PriorShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriorShift_intervalId_idx" ON "PriorShift"("intervalId");

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_intervalId_fkey" FOREIGN KEY ("intervalId") REFERENCES "Interval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicDay" ADD CONSTRAINT "AcademicDay_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorShift" ADD CONSTRAINT "PriorShift_intervalId_fkey" FOREIGN KEY ("intervalId") REFERENCES "Interval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorShift" ADD CONSTRAINT "PriorShift_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorShift" ADD CONSTRAINT "PriorShift_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ShiftCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma's schema language cannot express (same text as in datamodel/constraints.sql)
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_share_range" CHECK ("sharePercent" IS NULL OR ("sharePercent" BETWEEN 0 AND 100));
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_dates_order" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_window_range" CHECK (("startMinute" IS NULL) = ("endMinute" IS NULL) AND ("startMinute" IS NULL OR ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 0 AND 1440 AND "startMinute" <> "endMinute")));
ALTER TABLE "PriorShift" ADD CONSTRAINT "PriorShift_times" CHECK ("startMinute" BETWEEN 0 AND 1439 AND "durationMinutes" BETWEEN 1 AND 2880);

-- Shift counts now come from the role. (Done as asked on 17 Nov 2026; an adjustment still moves them.)
UPDATE "Assignment" SET "minShifts" = NULL, "maxShifts" = NULL;
-- link existing assignments to their interval when exactly one interval of the program overlaps them
UPDATE "Assignment" a SET "intervalId" = i.id FROM "Interval" i
 WHERE a."intervalId" IS NULL AND i."programId" = a."programId" AND i."startDate" <= a."endDate" AND i."endDate" >= a."startDate"
   AND (SELECT count(*) FROM "Interval" j WHERE j."programId" = a."programId" AND j."startDate" <= a."endDate" AND j."endDate" >= a."startDate") = 1;
