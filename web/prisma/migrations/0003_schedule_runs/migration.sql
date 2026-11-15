-- Engine runs started from the app: status, timing, input fingerprint and failure reason on Schedule.

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "runStatus" "RunStatus" NOT NULL DEFAULT 'DONE',
ADD COLUMN     "timeBudget" INTEGER,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "inputHash" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "workDir" TEXT,
ADD COLUMN     "workerPid" INTEGER;

-- Rules Prisma's schema language cannot express (same text as in datamodel/constraints.sql)

-- one engine run at a time per interval
CREATE UNIQUE INDEX "Schedule_one_active_run" ON "Schedule" ("intervalId") WHERE "runStatus" IN ('QUEUED', 'RUNNING');

-- only a finished schedule can be published
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_published_is_done" CHECK (status <> 'PUBLISHED' OR "runStatus" = 'DONE');
