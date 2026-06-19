CREATE TABLE "DashboardWarningDismissal" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "babyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "dismissedByMemberId" TEXT NOT NULL,
  "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DashboardWarningDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DashboardWarningDismissal_householdId_babyId_type_fingerprint_key"
  ON "DashboardWarningDismissal"("householdId", "babyId", "type", "fingerprint");

CREATE INDEX "DashboardWarningDismissal_householdId_babyId_idx"
  ON "DashboardWarningDismissal"("householdId", "babyId");

CREATE INDEX "DashboardWarningDismissal_dismissedByMemberId_idx"
  ON "DashboardWarningDismissal"("dismissedByMemberId");

ALTER TABLE "DashboardWarningDismissal"
  ADD CONSTRAINT "DashboardWarningDismissal_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DashboardWarningDismissal"
  ADD CONSTRAINT "DashboardWarningDismissal_babyId_fkey"
  FOREIGN KEY ("babyId") REFERENCES "Baby"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DashboardWarningDismissal"
  ADD CONSTRAINT "DashboardWarningDismissal_dismissedByMemberId_fkey"
  FOREIGN KEY ("dismissedByMemberId") REFERENCES "HouseholdMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
