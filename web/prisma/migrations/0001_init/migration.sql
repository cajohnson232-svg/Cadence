CREATE TYPE "AccessLevel" AS ENUM ('ADMIN', 'CHIEF', 'RESIDENT');
CREATE TYPE "IntervalStatus" AS ENUM ('DRAFT', 'LOCKED', 'PUBLISHED');
CREATE TYPE "SpecialMode" AS ENUM ('REPLACE', 'MODIFY');
CREATE TYPE "SpecialAction" AS ENUM ('ADD', 'CHANGE', 'REMOVE');
CREATE TYPE "OverlapPolicy" AS ENUM ('BLOCKED', 'EXCUSED');
CREATE TYPE "AttendanceException" AS ENUM ('EXCUSED', 'REQUIRED');
CREATE TYPE "TimeOffKind" AS ENUM ('VACATION', 'REQUEST_OFF', 'FIRST_DAY_OFF', 'LAST_DAY_OFF');
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
CREATE TYPE "RuleScope" AS ENUM ('PROGRAM', 'INSTITUTION', 'ROLE', 'PARTICIPANT');
CREATE TYPE "RuleLevel" AS ENUM ('HARD', 'SOFT');
CREATE TYPE "RuleSource" AS ENUM ('SYSTEM', 'MANUAL', 'AI_ASSISTED');
CREATE TYPE "ScheduleSource" AS ENUM ('SOLVER', 'IMPORT', 'MANUAL');
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TABLE "Program" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Program_pkey" PRIMARY KEY ("id"),
  "name" TEXT NOT NULL,
  "shortCode" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
  "defaultRequestAllowance" INTEGER NOT NULL DEFAULT 4,
  "defaultHighPriorityAllowance" INTEGER NOT NULL DEFAULT 1,
  "requestsRequireApproval" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Membership" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "access" "AccessLevel" NOT NULL,
  "participantId" TEXT
);
CREATE TABLE "Institution" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Institution_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortCode" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "address" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "Area" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Area_pkey" PRIMARY KEY ("id"),
  "institutionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortCode" TEXT NOT NULL
);
CREATE TABLE "Role" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "defaultMinShifts" INTEGER,
  "defaultMaxShifts" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "Participant" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Participant_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "calendarToken" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "ShiftCategory" (
  "id" TEXT NOT NULL,
  CONSTRAINT "ShiftCategory_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "isNight" BOOLEAN NOT NULL DEFAULT false,
  "balanceGroup" TEXT,
  "color" TEXT
);
CREATE TABLE "Shift" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Shift_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "areaId" TEXT,
  "categoryId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "daysOfWeek" INTEGER[],
  "countsAsPreviousDay" BOOLEAN NOT NULL DEFAULT false,
  "minParticipants" INTEGER NOT NULL DEFAULT 1,
  "maxParticipants" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "ShiftRole" (
  "shiftId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "eligible" BOOLEAN NOT NULL DEFAULT true,
  "requiredCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ShiftRole_pkey" PRIMARY KEY ("shiftId", "roleId")
);
CREATE TABLE "Interval" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Interval_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "status" "IntervalStatus" NOT NULL DEFAULT 'DRAFT',
  "requestsOpen" BOOLEAN NOT NULL DEFAULT true,
  "requestDeadline" TIMESTAMP(3),
  "requestAllowance" INTEGER,
  "highPriorityAllowance" INTEGER,
  "lockedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3)
);
CREATE TABLE "Assignment" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "minShifts" INTEGER NOT NULL,
  "maxShifts" INTEGER NOT NULL,
  "notes" TEXT
);
CREATE TABLE "AssignmentInstitution" (
  "assignmentId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  CONSTRAINT "AssignmentInstitution_pkey" PRIMARY KEY ("assignmentId", "institutionId")
);
CREATE TABLE "AssignmentShift" (
  "assignmentId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  CONSTRAINT "AssignmentShift_pkey" PRIMARY KEY ("assignmentId", "shiftId")
);
CREATE TABLE "SpecialStaffingDay" (
  "id" TEXT NOT NULL,
  CONSTRAINT "SpecialStaffingDay_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "mode" "SpecialMode" NOT NULL
);
CREATE TABLE "SpecialStaffingShift" (
  "id" TEXT NOT NULL,
  CONSTRAINT "SpecialStaffingShift_pkey" PRIMARY KEY ("id"),
  "specialStaffingDayId" TEXT NOT NULL,
  "action" "SpecialAction" NOT NULL,
  "shiftId" TEXT,
  "name" TEXT,
  "categoryId" TEXT,
  "areaId" TEXT,
  "startMinute" INTEGER,
  "durationMinutes" INTEGER,
  "countsAsPreviousDay" BOOLEAN,
  "minParticipants" INTEGER,
  "maxParticipants" INTEGER
);
CREATE TABLE "AcademicDay" (
  "id" TEXT NOT NULL,
  CONSTRAINT "AcademicDay_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "startDate" DATE,
  "endDate" DATE,
  "overlapPolicy" "OverlapPolicy" NOT NULL DEFAULT 'BLOCKED',
  "protectBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
  "protectAfterMinutes" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "AcademicDayRole" (
  "academicDayId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  CONSTRAINT "AcademicDayRole_pkey" PRIMARY KEY ("academicDayId", "roleId")
);
CREATE TABLE "AcademicDayOccurrence" (
  "id" TEXT NOT NULL,
  CONSTRAINT "AcademicDayOccurrence_pkey" PRIMARY KEY ("id"),
  "academicDayId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "cancelled" BOOLEAN NOT NULL DEFAULT false,
  "startMinute" INTEGER,
  "durationMinutes" INTEGER,
  "overlapPolicy" "OverlapPolicy"
);
CREATE TABLE "AcademicDayException" (
  "id" TEXT NOT NULL,
  CONSTRAINT "AcademicDayException_pkey" PRIMARY KEY ("id"),
  "academicDayId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "type" "AttendanceException" NOT NULL,
  "startDate" DATE,
  "endDate" DATE,
  "reason" TEXT
);
CREATE TABLE "TimeOff" (
  "id" TEXT NOT NULL,
  CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "intervalId" TEXT,
  "assignmentId" TEXT,
  "kind" "TimeOffKind" NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "priority" "Priority",
  "mandatory" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "status" "RequestStatus" NOT NULL DEFAULT 'APPROVED',
  "allowanceOverride" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ShiftAdjustment" (
  "id" TEXT NOT NULL,
  CONSTRAINT "ShiftAdjustment_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "intervalId" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Rule" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Rule_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "scope" "RuleScope" NOT NULL,
  "institutionId" TEXT,
  "roleId" TEXT,
  "participantId" TEXT,
  "template" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "level" "RuleLevel" NOT NULL,
  "weight" INTEGER,
  "priority" INTEGER,
  "activeFrom" DATE,
  "activeTo" DATE,
  "notes" TEXT,
  "originalText" TEXT,
  "source" "RuleSource" NOT NULL DEFAULT 'MANUAL',
  "needsReview" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "Schedule" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id"),
  "intervalId" TEXT NOT NULL,
  "source" "ScheduleSource" NOT NULL,
  "status" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT',
  "label" TEXT,
  "inputSnapshot" JSONB,
  "report" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3)
);
CREATE TABLE "ScheduledShift" (
  "id" TEXT NOT NULL,
  CONSTRAINT "ScheduledShift_pkey" PRIMARY KEY ("id"),
  "scheduleId" TEXT NOT NULL,
  "participantId" TEXT,
  "institutionId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "shiftId" TEXT,
  "specialStaffingShiftId" TEXT,
  "name" TEXT NOT NULL,
  "dutyDate" DATE NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  "programId" TEXT NOT NULL,
  "userId" TEXT,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "changes" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Program_shortCode_key" ON "Program" ("shortCode");
CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");
CREATE UNIQUE INDEX "Membership_participantId_key" ON "Membership" ("participantId");
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Membership_programId_userId_key" ON "Membership" ("programId", "userId");
ALTER TABLE "Institution" ADD CONSTRAINT "Institution_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Institution_programId_shortCode_key" ON "Institution" ("programId", "shortCode");
ALTER TABLE "Area" ADD CONSTRAINT "Area_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Area_institutionId_shortCode_key" ON "Area" ("institutionId", "shortCode");
ALTER TABLE "Role" ADD CONSTRAINT "Role_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Role_programId_name_key" ON "Role" ("programId", "name");
CREATE UNIQUE INDEX "Participant_calendarToken_key" ON "Participant" ("calendarToken");
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Participant_programId_email_key" ON "Participant" ("programId", "email");
CREATE INDEX "Participant_programId_lastName_idx" ON "Participant" ("programId", "lastName");
ALTER TABLE "ShiftCategory" ADD CONSTRAINT "ShiftCategory_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ShiftCategory_programId_name_key" ON "ShiftCategory" ("programId", "name");
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ShiftCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Shift_institutionId_name_key" ON "Shift" ("institutionId", "name");
ALTER TABLE "ShiftRole" ADD CONSTRAINT "ShiftRole_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftRole" ADD CONSTRAINT "ShiftRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Interval" ADD CONSTRAINT "Interval_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Interval_programId_name_key" ON "Interval" ("programId", "name");
CREATE INDEX "Interval_programId_startDate_idx" ON "Interval" ("programId", "startDate");
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Assignment_participantId_startDate_idx" ON "Assignment" ("participantId", "startDate");
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignmentInstitution" ADD CONSTRAINT "AssignmentInstitution_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssignmentShift" ADD CONSTRAINT "AssignmentShift_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignmentShift" ADD CONSTRAINT "AssignmentShift_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SpecialStaffingDay" ADD CONSTRAINT "SpecialStaffingDay_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SpecialStaffingDay" ADD CONSTRAINT "SpecialStaffingDay_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "SpecialStaffingDay_institutionId_date_key" ON "SpecialStaffingDay" ("institutionId", "date");
ALTER TABLE "SpecialStaffingShift" ADD CONSTRAINT "SpecialStaffingShift_specialStaffingDayId_fkey" FOREIGN KEY ("specialStaffingDayId") REFERENCES "SpecialStaffingDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpecialStaffingShift" ADD CONSTRAINT "SpecialStaffingShift_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SpecialStaffingShift" ADD CONSTRAINT "SpecialStaffingShift_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ShiftCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SpecialStaffingShift" ADD CONSTRAINT "SpecialStaffingShift_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AcademicDay" ADD CONSTRAINT "AcademicDay_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademicDayRole" ADD CONSTRAINT "AcademicDayRole_academicDayId_fkey" FOREIGN KEY ("academicDayId") REFERENCES "AcademicDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademicDayRole" ADD CONSTRAINT "AcademicDayRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademicDayOccurrence" ADD CONSTRAINT "AcademicDayOccurrence_academicDayId_fkey" FOREIGN KEY ("academicDayId") REFERENCES "AcademicDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AcademicDayOccurrence_academicDayId_date_key" ON "AcademicDayOccurrence" ("academicDayId", "date");
ALTER TABLE "AcademicDayException" ADD CONSTRAINT "AcademicDayException_academicDayId_fkey" FOREIGN KEY ("academicDayId") REFERENCES "AcademicDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademicDayException" ADD CONSTRAINT "AcademicDayException_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_intervalId_fkey" FOREIGN KEY ("intervalId") REFERENCES "Interval" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "TimeOff_participantId_startDate_idx" ON "TimeOff" ("participantId", "startDate");
CREATE INDEX "TimeOff_intervalId_kind_idx" ON "TimeOff" ("intervalId", "kind");
ALTER TABLE "ShiftAdjustment" ADD CONSTRAINT "ShiftAdjustment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAdjustment" ADD CONSTRAINT "ShiftAdjustment_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAdjustment" ADD CONSTRAINT "ShiftAdjustment_intervalId_fkey" FOREIGN KEY ("intervalId") REFERENCES "Interval" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAdjustment" ADD CONSTRAINT "ShiftAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ShiftAdjustment_intervalId_participantId_idx" ON "ShiftAdjustment" ("intervalId", "participantId");
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Rule_programId_template_idx" ON "Rule" ("programId", "template");
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_intervalId_fkey" FOREIGN KEY ("intervalId") REFERENCES "Interval" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Schedule_intervalId_status_idx" ON "Schedule" ("intervalId", "status");
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ShiftCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_specialStaffingShiftId_fkey" FOREIGN KEY ("specialStaffingShiftId") REFERENCES "SpecialStaffingShift" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ScheduledShift_scheduleId_dutyDate_idx" ON "ScheduledShift" ("scheduleId", "dutyDate");
CREATE INDEX "ScheduledShift_participantId_startsAt_idx" ON "ScheduledShift" ("participantId", "startsAt");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AuditLog_programId_entity_entityId_idx" ON "AuditLog" ("programId", "entity", "entityId");

