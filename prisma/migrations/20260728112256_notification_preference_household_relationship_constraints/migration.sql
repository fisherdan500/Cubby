BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "NotificationPreference" AS preference
    LEFT JOIN "Baby" AS baby ON baby."id" = preference."babyId"
    WHERE preference."babyId" IS NOT NULL
      AND (baby."id" IS NULL OR preference."householdId" <> baby."householdId")
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:notification_preference_baby';
  END IF;
END
$$;

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "NotificationPreference"
  VALIDATE CONSTRAINT "NotificationPreference_householdId_babyId_fkey";

COMMIT;
