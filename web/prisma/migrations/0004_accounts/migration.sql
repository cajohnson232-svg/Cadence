-- Real sign-in: passwords, one-time invitation / reset links, sign-in throttling.
-- Also records which server instance runs an engine job.

-- CreateEnum
CREATE TYPE "AccessLinkPurpose" AS ENUM ('INVITE', 'RESET');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordSetAt" TIMESTAMP(3),
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "workerHost" TEXT;

-- CreateTable
CREATE TABLE "AccessLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "AccessLinkPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AccessLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignInThrottle" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "SignInThrottle_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessLink_tokenHash_key" ON "AccessLink"("tokenHash");

-- CreateIndex
CREATE INDEX "AccessLink_userId_idx" ON "AccessLink"("userId");

-- AddForeignKey
ALTER TABLE "AccessLink" ADD CONSTRAINT "AccessLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessLink" ADD CONSTRAINT "AccessLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules Prisma's schema language cannot express (same text as in datamodel/constraints.sql)

-- an email address is stored in lower case, so "Pat@x.org" and "pat@x.org" cannot be two accounts
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK (email = lower(email));
