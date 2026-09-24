-- One caregiver-written plan per baby (DEC-PROD-148, DEC-PROD-420), kept apart from logged activity.
-- The baby reference carries the household, so a plan can only ever belong to a baby of its own
-- household.
CREATE TABLE "PlannedSchedule" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "babyId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "document" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedSchedule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlannedSchedule_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PlannedSchedule_document_check" CHECK (jsonb_typeof("document") = 'object')
);

CREATE UNIQUE INDEX "PlannedSchedule_babyId_key" ON "PlannedSchedule"("babyId");

CREATE UNIQUE INDEX "PlannedSchedule_householdId_babyId_key" ON "PlannedSchedule"("householdId", "babyId");

ALTER TABLE "PlannedSchedule" ADD CONSTRAINT "PlannedSchedule_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlannedSchedule" ADD CONSTRAINT "PlannedSchedule_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Saving a plan binds its operation to the baby, as the lifecycle operations do. Every other case is
-- unchanged from 20260918120000_notification_preference_target_shape.
ALTER TABLE "BrowserOperationBinding" DROP CONSTRAINT "BrowserOperationBinding_target_shape_check";
ALTER TABLE "BrowserOperationBinding" ADD CONSTRAINT "BrowserOperationBinding_target_shape_check" CHECK (
  "persistenceVersion" = 1 OR
  CASE "operationKey"::text
    WHEN 'activity.create' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'activity.update' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.delete' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.undo_last' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.pause' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.resume' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.stop' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'baby.create' THEN "targetKind" = 'baby' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'baby.deactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'baby.reactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'dashboard.warning.dismiss' THEN "targetKind" = 'warning' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
    WHEN 'invite.create' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'invite.revoke' THEN "targetKind" = 'invite' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'invite.revoke_all' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'member.restore' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.remove' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.role.update' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.suspend' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'notification.preference.save' THEN "targetKind" = 'preference' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'settings.units.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'calendar_event.create' THEN "targetKind" = 'calendar' AND "targetId" IS NULL AND "babyId" IS NOT NULL
    WHEN 'household.accent.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'api_key.revoke' THEN "targetKind" = 'api_key' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'planned_schedule.save' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    ELSE false
  END
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE "PlannedSchedule" TO cubby_runtime';
  END IF;
END $$;
