-- Forward-only replacement of the legacy multi-row user preference shape.
-- This migration never enables delivery and never guesses a membership episode.
BEGIN;

ALTER TABLE "NotificationPreference" RENAME TO "LegacyNotificationPreference";

CREATE TYPE "NotificationPreferenceStatus" AS ENUM ('active', 'needs_review');
CREATE TYPE "NotificationBabyScope" AS ENUM ('all', 'selected');
CREATE TYPE "NotificationInterruptionLevel" AS ENUM ('passive', 'normal', 'time_sensitive');

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "status" "NotificationPreferenceStatus" NOT NULL DEFAULT 'active',
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "externalDeliveryEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "babyScope" "NotificationBabyScope" NOT NULL DEFAULT 'all',
  "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "quietHoursStart" TEXT,
  "quietHoursEnd" TEXT,
  "interruptionLevel" "NotificationInterruptionLevel" NOT NULL DEFAULT 'normal',
  "destinationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "migrationEvidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationPreference_householdId_memberId_key" UNIQUE ("householdId", "memberId"),
  CONSTRAINT "NotificationPreference_householdId_id_key" UNIQUE ("householdId", "id"),
  CONSTRAINT "NotificationPreference_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "NotificationPreference_quiet_hours_pair_check" CHECK (("quietHoursStart" IS NULL) = ("quietHoursEnd" IS NULL))
);

CREATE TABLE "NotificationPreferenceBaby" (
  "householdId" TEXT NOT NULL,
  "preferenceId" TEXT NOT NULL,
  "babyId" TEXT NOT NULL,
  CONSTRAINT "NotificationPreferenceBaby_pkey" PRIMARY KEY ("preferenceId", "babyId")
);

-- A legacy cross-household baby reference cannot be safely represented by either
-- active or needs-review content. Stop before any document is created instead of
-- repairing or inspecting personal preference content.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "LegacyNotificationPreference" legacy
    LEFT JOIN "Baby" baby ON baby."id" = legacy."babyId"
    WHERE legacy."babyId" IS NOT NULL
      AND (baby."id" IS NULL OR baby."householdId" <> legacy."householdId")
  ) THEN
    RAISE EXCEPTION 'notification_preference_legacy_preflight_failed:baby_household';
  END IF;
END
$$;

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "NotificationPreference_householdId_memberId_fkey"
  FOREIGN KEY ("householdId", "memberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "NotificationPreferenceBaby"
  ADD CONSTRAINT "NotificationPreferenceBaby_householdId_preferenceId_fkey"
  FOREIGN KEY ("householdId", "preferenceId") REFERENCES "NotificationPreference"("householdId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "NotificationPreferenceBaby_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "NotificationPreference_householdId_status_idx" ON "NotificationPreference"("householdId", "status");
CREATE INDEX "NotificationPreference_memberId_idx" ON "NotificationPreference"("memberId");
CREATE INDEX "NotificationPreferenceBaby_householdId_babyId_idx" ON "NotificationPreferenceBaby"("householdId", "babyId");

-- The preference target is the immutable current membership episode rather
-- than a household-wide or caller-selected target. The v2 foundation already
-- declares this target kind; replace only the one shape rule that previously
-- reserved notification preferences without a target id.
ALTER TABLE "BrowserOperationBinding"
  DROP CONSTRAINT "BrowserOperationBinding_target_shape_check",
  ADD CONSTRAINT "BrowserOperationBinding_target_shape_check" CHECK (
    "persistenceVersion" = 1 OR
    CASE "operationKey"::text
      WHEN 'activity.create' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
      WHEN 'activity.update' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.delete' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.undo_last' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.pause' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.resume' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.stop' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
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
      ELSE false
    END
  );

-- Only one legacy row plus exactly one current membership episode can preserve
-- one-document semantics. The translated document has no destination/channel
-- authority and external delivery is explicitly off.
WITH legacy_groups AS (
  SELECT legacy."householdId", legacy."userId", COUNT(*)::INTEGER AS legacy_row_count
  FROM "LegacyNotificationPreference" legacy
  GROUP BY legacy."householdId", legacy."userId"
), current_episodes AS (
  SELECT member."householdId", member."userId", MIN(member."id") AS "memberId", COUNT(*)::INTEGER AS episode_count
  FROM "HouseholdMember" member
  WHERE member."deletedAt" IS NULL AND member."disabledAt" IS NULL
  GROUP BY member."householdId", member."userId"
), deterministic_rows AS (
  SELECT legacy.*, episode."memberId"
  FROM "LegacyNotificationPreference" legacy
  JOIN legacy_groups grouped ON grouped."householdId" = legacy."householdId" AND grouped."userId" = legacy."userId"
  JOIN current_episodes episode ON episode."householdId" = legacy."householdId" AND episode."userId" = legacy."userId"
  LEFT JOIN "Baby" baby ON baby."id" = legacy."babyId" AND baby."householdId" = legacy."householdId"
  WHERE grouped.legacy_row_count = 1
    AND episode.episode_count = 1
    AND (legacy."babyId" IS NULL OR (baby."deletedAt" IS NULL AND baby."inactiveAt" IS NULL))
)
INSERT INTO "NotificationPreference" (
  "id", "householdId", "memberId", "status", "schemaVersion", "revision", "externalDeliveryEnabled", "babyScope",
  "categories", "channels", "quietHoursStart", "quietHoursEnd", "interruptionLevel", "destinationIds", "migrationEvidence", "createdAt", "updatedAt"
)
SELECT
  'np_' || md5(legacy."id" || ':v1'), legacy."householdId", legacy."memberId", 'active', 1, 1, FALSE,
  CASE WHEN legacy."babyId" IS NULL THEN 'all'::"NotificationBabyScope" ELSE 'selected'::"NotificationBabyScope" END,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN legacy."timerOverdue" THEN 'timer_overdue' END,
    CASE WHEN legacy."activityCreated" THEN 'activity_created' END,
    CASE WHEN legacy."reminders" THEN 'reminder_due' END
  ], NULL), ARRAY[]::TEXT[], legacy."quietHoursStart", legacy."quietHoursEnd", 'normal', ARRAY[]::TEXT[],
  jsonb_build_object('kind', 'legacy_translated', 'schema_version', 1), legacy."createdAt", legacy."updatedAt"
FROM deterministic_rows legacy;

INSERT INTO "NotificationPreferenceBaby" ("householdId", "preferenceId", "babyId")
SELECT document."householdId", document."id", legacy."babyId"
FROM "LegacyNotificationPreference" legacy
JOIN "NotificationPreference" document
  ON document."id" = 'np_' || md5(legacy."id" || ':v1')
WHERE document."babyScope" = 'selected';

-- Multiple, duplicate, overlapping, inactive-target, or episode-ambiguous rows
-- are not unioned or resolved by age. One content-minimized inactive evidence
-- document is retained only for an exact current episode; others remain legacy
-- evidence with no new effective document and no delivery authority.
WITH legacy_groups AS (
  SELECT legacy."householdId", legacy."userId", COUNT(*)::INTEGER AS legacy_row_count
  FROM "LegacyNotificationPreference" legacy
  GROUP BY legacy."householdId", legacy."userId"
), current_episodes AS (
  SELECT member."householdId", member."userId", MIN(member."id") AS "memberId", COUNT(*)::INTEGER AS episode_count
  FROM "HouseholdMember" member
  WHERE member."deletedAt" IS NULL AND member."disabledAt" IS NULL
  GROUP BY member."householdId", member."userId"
), ambiguous AS (
  SELECT grouped."householdId", grouped."userId", grouped.legacy_row_count, episode."memberId", episode.episode_count
  FROM legacy_groups grouped
  JOIN current_episodes episode ON episode."householdId" = grouped."householdId" AND episode."userId" = grouped."userId"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "NotificationPreference" document
    WHERE document."householdId" = grouped."householdId" AND document."memberId" = episode."memberId"
  )
    AND episode.episode_count = 1
)
INSERT INTO "NotificationPreference" (
  "id", "householdId", "memberId", "status", "schemaVersion", "revision", "externalDeliveryEnabled", "babyScope",
  "categories", "channels", "interruptionLevel", "destinationIds", "migrationEvidence"
)
SELECT
  'np_' || md5(ambiguous."householdId" || ':' || ambiguous."memberId" || ':needs_review'), ambiguous."householdId", ambiguous."memberId",
  'needs_review', 1, 1, FALSE, 'selected', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'normal', ARRAY[]::TEXT[],
  jsonb_build_object('kind', 'needs_review', 'legacy_row_count', ambiguous.legacy_row_count, 'schema_version', 1)
FROM ambiguous;

COMMIT;
