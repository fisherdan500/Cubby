ALTER TABLE "HouseholdMember" ADD COLUMN "disabledAt" TIMESTAMP(3);

CREATE INDEX "HouseholdMember_userId_disabledAt_deletedAt_idx"
ON "HouseholdMember"("userId", "disabledAt", "deletedAt");

CREATE FUNCTION "require_active_membership_for_session"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM member."id"
  FROM "HouseholdMember" AS member
  INNER JOIN "Household" AS household ON household."id" = member."householdId"
  WHERE member."userId" = NEW."userId"
    AND member."deletedAt" IS NULL
    AND household."deletedAt" IS NULL
  ORDER BY member."id"
  FOR SHARE OF member;

  IF EXISTS (
    SELECT 1
    FROM "HouseholdMember" AS member
    INNER JOIN "Household" AS household ON household."id" = member."householdId"
    WHERE member."userId" = NEW."userId"
      AND member."disabledAt" IS NULL
      AND member."deletedAt" IS NULL
      AND household."deletedAt" IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "HouseholdMember" AS member
    INNER JOIN "Household" AS household ON household."id" = member."householdId"
    WHERE member."userId" = NEW."userId"
      AND member."disabledAt" IS NOT NULL
      AND member."deletedAt" IS NULL
      AND household."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Your account is disabled.' USING ERRCODE = 'CUB01';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Session_require_active_membership"
BEFORE INSERT ON "Session"
FOR EACH ROW
EXECUTE FUNCTION "require_active_membership_for_session"();
