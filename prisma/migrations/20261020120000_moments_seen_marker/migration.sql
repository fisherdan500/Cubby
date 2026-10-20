-- When a member last looked at Moments: one row per member, upserted on each visit, read to badge
-- the Moments tab with how many moments arrived since. The member reference is the composite
-- (householdId, id), so a marker is same-tenant by construction.
CREATE TABLE "MomentsSeenMarker" (
  "householdId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MomentsSeenMarker_pkey" PRIMARY KEY ("householdId", "memberId")
);

ALTER TABLE "MomentsSeenMarker"
  ADD CONSTRAINT "MomentsSeenMarker_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MomentsSeenMarker"
  ADD CONSTRAINT "MomentsSeenMarker_householdId_memberId_fkey"
  FOREIGN KEY ("householdId", "memberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

REVOKE ALL ON "MomentsSeenMarker" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "MomentsSeenMarker" TO cubby_runtime;
