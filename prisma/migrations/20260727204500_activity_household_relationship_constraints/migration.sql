-- One explicit PostgreSQL transaction keeps preflight, constraints, and validation atomic.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ActivityLog" AS activity
    LEFT JOIN "Baby" AS baby ON baby."id" = activity."babyId"
    WHERE baby."id" IS NULL
      OR activity."householdId" <> baby."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_baby';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityLog" AS activity
    LEFT JOIN "HouseholdMember" AS member ON member."id" = activity."actorMemberId"
    WHERE member."id" IS NULL
      OR activity."householdId" <> member."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_actor_member';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityLog" AS activity
    LEFT JOIN "HouseholdMember" AS member ON member."id" = activity."deletedByMemberId"
    WHERE activity."deletedByMemberId" IS NOT NULL
      AND (member."id" IS NULL OR activity."householdId" <> member."householdId")
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_deleted_by_member';
  END IF;
END
$$;

ALTER TABLE "Baby"
  ADD CONSTRAINT "Baby_householdId_id_key" UNIQUE ("householdId", "id");

ALTER TABLE "HouseholdMember"
  ADD CONSTRAINT "HouseholdMember_householdId_id_key" UNIQUE ("householdId", "id");

ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey"
  FOREIGN KEY ("householdId", "actorMemberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey"
  FOREIGN KEY ("householdId", "deletedByMemberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ActivityLog"
  VALIDATE CONSTRAINT "ActivityLog_householdId_babyId_fkey";

ALTER TABLE "ActivityLog"
  VALIDATE CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey";

ALTER TABLE "ActivityLog"
  VALIDATE CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey";

COMMIT;
