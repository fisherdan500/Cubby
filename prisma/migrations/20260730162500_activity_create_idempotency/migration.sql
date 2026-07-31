ALTER TABLE "ActivityLog"
  ADD COLUMN "clientMutationFingerprint" TEXT;

CREATE UNIQUE INDEX "ActivityLog_householdId_clientMutationId_key"
  ON "ActivityLog"("householdId", "clientMutationId");
