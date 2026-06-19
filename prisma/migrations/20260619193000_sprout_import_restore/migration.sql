-- Add Sprout Track import support without changing existing Cubby records.

ALTER TABLE "ActivityLog"
  ADD COLUMN "externalActorName" TEXT;

ALTER TABLE "Contact"
  ADD COLUMN "address" TEXT;

CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "sourceSystem" TEXT NOT NULL,
  "sourceFilename" TEXT,
  "sourceFormat" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "summary" JSONB,
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportedRecord" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "importBatchId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "sourceTable" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "checksum" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportedRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MedicineCatalog" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "typicalDoseSize" DECIMAL(10,2),
  "unit" TEXT,
  "doseMinTime" TEXT,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "isSupplement" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "MedicineCatalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarEvent" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3),
  "allDay" BOOLEAN NOT NULL DEFAULT false,
  "eventType" TEXT,
  "location" TEXT,
  "color" TEXT,
  "recurring" BOOLEAN NOT NULL DEFAULT false,
  "recurrencePattern" TEXT,
  "recurrenceEnd" TIMESTAMP(3),
  "customRecurrence" TEXT,
  "reminderMinutes" INTEGER,
  "notificationSent" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "externalCaretakerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarEventBaby" (
  "babyId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  CONSTRAINT "CalendarEventBaby_pkey" PRIMARY KEY ("babyId", "eventId")
);

CREATE TABLE "CalendarEventContact" (
  "contactId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  CONSTRAINT "CalendarEventContact_pkey" PRIMARY KEY ("contactId", "eventId")
);

CREATE TABLE "VaccineDocument" (
  "id" TEXT NOT NULL,
  "vaccineLogId" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "storedName" TEXT,
  "mimeType" TEXT,
  "fileSize" INTEGER,
  "sourcePath" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaccineDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportBatch_householdId_idx" ON "ImportBatch"("householdId");
CREATE INDEX "ImportBatch_sourceSystem_idx" ON "ImportBatch"("sourceSystem");
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

CREATE UNIQUE INDEX "ImportedRecord_householdId_sourceSystem_sourceTable_sourceId_key"
  ON "ImportedRecord"("householdId", "sourceSystem", "sourceTable", "sourceId");
CREATE INDEX "ImportedRecord_householdId_idx" ON "ImportedRecord"("householdId");
CREATE INDEX "ImportedRecord_importBatchId_idx" ON "ImportedRecord"("importBatchId");
CREATE INDEX "ImportedRecord_targetType_targetId_idx" ON "ImportedRecord"("targetType", "targetId");

CREATE INDEX "MedicineCatalog_householdId_idx" ON "MedicineCatalog"("householdId");
CREATE INDEX "MedicineCatalog_name_idx" ON "MedicineCatalog"("name");
CREATE INDEX "MedicineCatalog_isSupplement_idx" ON "MedicineCatalog"("isSupplement");
CREATE INDEX "MedicineCatalog_deletedAt_idx" ON "MedicineCatalog"("deletedAt");

CREATE INDEX "CalendarEvent_householdId_idx" ON "CalendarEvent"("householdId");
CREATE INDEX "CalendarEvent_startTime_idx" ON "CalendarEvent"("startTime");
CREATE INDEX "CalendarEvent_endTime_idx" ON "CalendarEvent"("endTime");
CREATE INDEX "CalendarEvent_eventType_idx" ON "CalendarEvent"("eventType");
CREATE INDEX "CalendarEvent_deletedAt_idx" ON "CalendarEvent"("deletedAt");

CREATE INDEX "CalendarEventBaby_babyId_idx" ON "CalendarEventBaby"("babyId");
CREATE INDEX "CalendarEventBaby_eventId_idx" ON "CalendarEventBaby"("eventId");
CREATE INDEX "CalendarEventContact_contactId_idx" ON "CalendarEventContact"("contactId");
CREATE INDEX "CalendarEventContact_eventId_idx" ON "CalendarEventContact"("eventId");
CREATE INDEX "VaccineDocument_vaccineLogId_idx" ON "VaccineDocument"("vaccineLogId");

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportedRecord" ADD CONSTRAINT "ImportedRecord_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedRecord" ADD CONSTRAINT "ImportedRecord_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MedicineCatalog" ADD CONSTRAINT "MedicineCatalog_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEventBaby" ADD CONSTRAINT "CalendarEventBaby_babyId_fkey"
  FOREIGN KEY ("babyId") REFERENCES "Baby"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEventBaby" ADD CONSTRAINT "CalendarEventBaby_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEventContact" ADD CONSTRAINT "CalendarEventContact_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEventContact" ADD CONSTRAINT "CalendarEventContact_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaccineDocument" ADD CONSTRAINT "VaccineDocument_vaccineLogId_fkey"
  FOREIGN KEY ("vaccineLogId") REFERENCES "VaccineLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
