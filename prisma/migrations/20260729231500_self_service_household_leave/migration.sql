ALTER TABLE "HouseholdMember"
  ADD COLUMN "closureReason" TEXT,
  ADD COLUMN "leaveOperationId" TEXT;

CREATE UNIQUE INDEX "HouseholdMember_leaveOperationId_key"
ON "HouseholdMember"("leaveOperationId");
