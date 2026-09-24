BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CalendarEventBaby" AS link
    LEFT JOIN "CalendarEvent" AS event ON event."id" = link."eventId"
    LEFT JOIN "Baby" AS baby ON baby."id" = link."babyId"
    WHERE event."id" IS NULL
      OR baby."id" IS NULL
      OR event."householdId" <> baby."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:calendar_event_baby';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "CalendarEventContact" AS link
    LEFT JOIN "CalendarEvent" AS event ON event."id" = link."eventId"
    LEFT JOIN "Contact" AS contact ON contact."id" = link."contactId"
    WHERE event."id" IS NULL
      OR contact."id" IS NULL
      OR event."householdId" <> contact."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:calendar_event_contact';
  END IF;
END $$;

ALTER TABLE "CalendarEventBaby" ADD COLUMN "householdId" TEXT;
ALTER TABLE "CalendarEventContact" ADD COLUMN "householdId" TEXT;

UPDATE "CalendarEventBaby" AS link
SET "householdId" = event."householdId"
FROM "CalendarEvent" AS event
WHERE event."id" = link."eventId";

UPDATE "CalendarEventContact" AS link
SET "householdId" = event."householdId"
FROM "CalendarEvent" AS event
WHERE event."id" = link."eventId";

ALTER TABLE "CalendarEventBaby" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "CalendarEventContact" ALTER COLUMN "householdId" SET NOT NULL;

ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_householdId_id_key" UNIQUE ("householdId", "id");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_householdId_id_key" UNIQUE ("householdId", "id");

CREATE INDEX "CalendarEventBaby_householdId_idx" ON "CalendarEventBaby"("householdId");
CREATE INDEX "CalendarEventContact_householdId_idx" ON "CalendarEventContact"("householdId");

ALTER TABLE "CalendarEventBaby" DROP CONSTRAINT "CalendarEventBaby_babyId_fkey";
ALTER TABLE "CalendarEventBaby" DROP CONSTRAINT "CalendarEventBaby_eventId_fkey";
ALTER TABLE "CalendarEventContact" DROP CONSTRAINT "CalendarEventContact_contactId_fkey";
ALTER TABLE "CalendarEventContact" DROP CONSTRAINT "CalendarEventContact_eventId_fkey";

ALTER TABLE "CalendarEventBaby"
  ADD CONSTRAINT "CalendarEventBaby_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CalendarEventBaby"
  ADD CONSTRAINT "CalendarEventBaby_householdId_eventId_fkey"
  FOREIGN KEY ("householdId", "eventId")
  REFERENCES "CalendarEvent" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CalendarEventContact"
  ADD CONSTRAINT "CalendarEventContact_householdId_contactId_fkey"
  FOREIGN KEY ("householdId", "contactId")
  REFERENCES "Contact" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CalendarEventContact"
  ADD CONSTRAINT "CalendarEventContact_householdId_eventId_fkey"
  FOREIGN KEY ("householdId", "eventId")
  REFERENCES "CalendarEvent" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CalendarEventBaby" VALIDATE CONSTRAINT "CalendarEventBaby_householdId_babyId_fkey";
ALTER TABLE "CalendarEventBaby" VALIDATE CONSTRAINT "CalendarEventBaby_householdId_eventId_fkey";
ALTER TABLE "CalendarEventContact" VALIDATE CONSTRAINT "CalendarEventContact_householdId_contactId_fkey";
ALTER TABLE "CalendarEventContact" VALIDATE CONSTRAINT "CalendarEventContact_householdId_eventId_fkey";

COMMIT;
