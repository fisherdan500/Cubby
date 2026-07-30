-- Suspended members may establish a session only; household authorization continues
-- to reject disabled memberships, while the self-service leave service accepts them.
CREATE OR REPLACE FUNCTION "require_active_membership_for_session"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Preserve the existing row-share serialization with membership suspension.
  PERFORM member."id"
  FROM "HouseholdMember" AS member
  INNER JOIN "Household" AS household ON household."id" = member."householdId"
  WHERE member."userId" = NEW."userId"
    AND member."deletedAt" IS NULL
    AND household."deletedAt" IS NULL
  ORDER BY member."id"
  FOR SHARE OF member;

  RETURN NEW;
END;
$$;
