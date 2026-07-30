DROP INDEX "HouseholdMember_householdId_userId_key";

CREATE UNIQUE INDEX "HouseholdMember_one_current_episode_key"
ON "HouseholdMember"("householdId", "userId")
WHERE "deletedAt" IS NULL;
