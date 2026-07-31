-- Durable receipt for replay-safe consequential mutations.
CREATE TABLE "MutationReceipt" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "actorMemberId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "operation" TEXT NOT NULL,
    "targetActivityId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "outcomeActivityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MutationReceipt_householdId_clientMutationId_key"
ON "MutationReceipt"("householdId", "clientMutationId");

CREATE INDEX "MutationReceipt_householdId_targetActivityId_idx"
ON "MutationReceipt"("householdId", "targetActivityId");

ALTER TABLE "MutationReceipt"
ADD CONSTRAINT "MutationReceipt_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
