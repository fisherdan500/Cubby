BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Reminder" AS reminder
    LEFT JOIN "Baby" AS baby ON baby."id" = reminder."babyId"
    WHERE baby."id" IS NULL
      OR reminder."householdId" <> baby."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:reminder_baby';
  END IF;
END
$$;

ALTER TABLE "Reminder"
  ADD CONSTRAINT "Reminder_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Reminder"
  VALIDATE CONSTRAINT "Reminder_householdId_babyId_fkey";

COMMIT;
