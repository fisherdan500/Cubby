-- One explicit PostgreSQL transaction keeps preflight, constraints, and validation atomic.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DashboardWarningDismissal" AS dismissal
    LEFT JOIN "Baby" AS baby ON baby."id" = dismissal."babyId"
    WHERE baby."id" IS NULL
      OR dismissal."householdId" <> baby."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:dashboard_warning_dismissal_baby';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DashboardWarningDismissal" AS dismissal
    LEFT JOIN "HouseholdMember" AS member ON member."id" = dismissal."dismissedByMemberId"
    WHERE member."id" IS NULL
      OR dismissal."householdId" <> member."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:dashboard_warning_dismissal_member';
  END IF;
END
$$;

ALTER TABLE "DashboardWarningDismissal"
  ADD CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "DashboardWarningDismissal"
  ADD CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey"
  FOREIGN KEY ("householdId", "dismissedByMemberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "DashboardWarningDismissal"
  VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey";

ALTER TABLE "DashboardWarningDismissal"
  VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey";

COMMIT;
