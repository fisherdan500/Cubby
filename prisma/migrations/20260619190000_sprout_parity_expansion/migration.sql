-- Expand Cubby toward full baby-tracker parity while preserving the ActivityLog aggregate model.

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'bath';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'play';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'mood';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'supplement';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'vaccine';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'milk_inventory';

ALTER TYPE "TimerState" ADD VALUE IF NOT EXISTS 'paused';

ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'sleep';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'play';

CREATE TYPE "MilkInventoryAction" AS ENUM ('stored', 'fed', 'discarded', 'thawed', 'donated', 'expired');
CREATE TYPE "WebhookEvent" AS ENUM ('activity_created', 'activity_updated', 'activity_deleted', 'timer_started', 'timer_stopped', 'reminder_due');
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'delivered', 'failed');

ALTER TABLE "Baby"
  ADD COLUMN "feedingWarningMinutes" INTEGER,
  ADD COLUMN "diaperWarningMinutes" INTEGER,
  ADD COLUMN "sleepWarningMinutes" INTEGER,
  ADD COLUMN "preferredUnits" JSONB;

ALTER TABLE "ActivityLog"
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pausedSeconds" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "FeedingLog"
  ADD COLUMN "bottleType" TEXT,
  ADD COLUMN "food" TEXT,
  ADD COLUMN "leftSeconds" INTEGER,
  ADD COLUMN "rightSeconds" INTEGER;

ALTER TABLE "DiaperLog"
  ADD COLUMN "condition" TEXT,
  ADD COLUMN "blowout" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "creamApplied" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SleepLog"
  ADD COLUMN "sleepType" TEXT,
  ADD COLUMN "location" TEXT,
  ADD COLUMN "quality" TEXT;

ALTER TABLE "PumpingLog"
  ADD COLUMN "inventoryAction" "MilkInventoryAction";

ALTER TABLE "MeasurementLog"
  ADD COLUMN "temperature" DECIMAL(10,2),
  ADD COLUMN "temperatureUnit" TEXT,
  ADD COLUMN "measurementType" TEXT;

CREATE TABLE "SupplementLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dose" DECIMAL(10,2),
  "unit" TEXT,
  CONSTRAINT "SupplementLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BathLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "bathType" TEXT,
  "products" TEXT,
  "waterTemp" TEXT,
  CONSTRAINT "BathLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "activityName" TEXT,
  "location" TEXT,
  "intensity" TEXT,
  CONSTRAINT "PlayLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MoodLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "mood" TEXT NOT NULL,
  "intensity" INTEGER,
  "context" TEXT,
  CONSTRAINT "MoodLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaccineLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dose" TEXT,
  "lot" TEXT,
  "provider" TEXT,
  "dueDate" TIMESTAMP(3),
  "documentUrl" TEXT,
  CONSTRAINT "VaccineLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MilkInventoryLog" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "action" "MilkInventoryAction" NOT NULL,
  "amount" DECIMAL(10,2),
  "unit" TEXT,
  "storage" TEXT,
  "label" TEXT,
  CONSTRAINT "MilkInventoryLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HouseholdSettings" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "allowPublicRegistration" BOOLEAN NOT NULL DEFAULT false,
  "allowNewHouseholdCreation" BOOLEAN NOT NULL DEFAULT false,
  "activityOrder" JSONB,
  "activityVisibility" JSONB,
  "unitPreferences" JSONB,
  "dateFormat" TEXT NOT NULL DEFAULT 'MMM d, yyyy',
  "timeFormat" TEXT NOT NULL DEFAULT 'h:mm a',
  "sleepLocations" TEXT[] NOT NULL DEFAULT ARRAY['Crib', 'Bassinet', 'Contact nap', 'Stroller', 'Car seat']::TEXT[],
  "medicines" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "supplements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "nurseryModeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "pwaInstallPromptEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HouseholdSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiKey" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "babyId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEndpoint" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "events" "WebhookEvent"[] NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "event" "WebhookEvent" NOT NULL,
  "activityId" TEXT,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lastStatusCode" INTEGER,
  "lastError" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "babyId" TEXT,
  "userId" TEXT NOT NULL,
  "timerOverdue" BOOLEAN NOT NULL DEFAULT true,
  "activityCreated" BOOLEAN NOT NULL DEFAULT false,
  "reminders" BOOLEAN NOT NULL DEFAULT true,
  "quietHoursStart" TEXT,
  "quietHoursEnd" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationLog" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "activityId" TEXT,
  "userId" TEXT,
  "kind" TEXT NOT NULL,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL,
  "body" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BackupRecord" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "itemCount" INTEGER,
  "checksum" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplementLog_activityId_key" ON "SupplementLog"("activityId");
CREATE UNIQUE INDEX "BathLog_activityId_key" ON "BathLog"("activityId");
CREATE UNIQUE INDEX "PlayLog_activityId_key" ON "PlayLog"("activityId");
CREATE UNIQUE INDEX "MoodLog_activityId_key" ON "MoodLog"("activityId");
CREATE UNIQUE INDEX "VaccineLog_activityId_key" ON "VaccineLog"("activityId");
CREATE UNIQUE INDEX "MilkInventoryLog_activityId_key" ON "MilkInventoryLog"("activityId");

CREATE UNIQUE INDEX "HouseholdSettings_householdId_key" ON "HouseholdSettings"("householdId");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

CREATE INDEX "ApiKey_householdId_idx" ON "ApiKey"("householdId");
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");
CREATE INDEX "WebhookEndpoint_householdId_idx" ON "WebhookEndpoint"("householdId");
CREATE INDEX "WebhookEndpoint_deletedAt_idx" ON "WebhookEndpoint"("deletedAt");
CREATE INDEX "WebhookDelivery_householdId_idx" ON "WebhookDelivery"("householdId");
CREATE INDEX "WebhookDelivery_endpointId_idx" ON "WebhookDelivery"("endpointId");
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
CREATE INDEX "PushSubscription_householdId_idx" ON "PushSubscription"("householdId");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
CREATE INDEX "PushSubscription_deletedAt_idx" ON "PushSubscription"("deletedAt");
CREATE INDEX "NotificationPreference_householdId_idx" ON "NotificationPreference"("householdId");
CREATE INDEX "NotificationPreference_userId_idx" ON "NotificationPreference"("userId");
CREATE INDEX "NotificationPreference_babyId_idx" ON "NotificationPreference"("babyId");
CREATE INDEX "NotificationLog_householdId_idx" ON "NotificationLog"("householdId");
CREATE INDEX "NotificationLog_activityId_idx" ON "NotificationLog"("activityId");
CREATE INDEX "NotificationLog_status_idx" ON "NotificationLog"("status");
CREATE INDEX "BackupRecord_householdId_idx" ON "BackupRecord"("householdId");
CREATE INDEX "BackupRecord_createdAt_idx" ON "BackupRecord"("createdAt");

ALTER TABLE "SupplementLog" ADD CONSTRAINT "SupplementLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BathLog" ADD CONSTRAINT "BathLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayLog" ADD CONSTRAINT "PlayLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoodLog" ADD CONSTRAINT "MoodLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaccineLog" ADD CONSTRAINT "VaccineLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MilkInventoryLog" ADD CONSTRAINT "MilkInventoryLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HouseholdSettings" ADD CONSTRAINT "HouseholdSettings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BackupRecord" ADD CONSTRAINT "BackupRecord_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupRecord" ADD CONSTRAINT "BackupRecord_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "HouseholdSettings" ("id", "householdId", "updatedAt")
SELECT 'hs_' || "id", "id", CURRENT_TIMESTAMP
FROM "Household"
WHERE "deletedAt" IS NULL
ON CONFLICT ("householdId") DO NOTHING;
