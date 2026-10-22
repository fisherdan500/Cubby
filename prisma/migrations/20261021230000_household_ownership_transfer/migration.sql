-- A household ownership transfer the owner has initiated and the recipient has not yet answered.
--
-- Ownership moves in two steps on purpose (DEC-PROD-017): the owner names a recipient and gives up
-- authority knowingly, and the recipient accepts knowingly. The row IS the pending state. It grants
-- no authority while it sits here; acceptance is what moves the role.
--
-- Both member references are composite (householdId, memberId), so a transfer cannot name a member
-- of another household -- the database refuses it rather than trusting the caller.
CREATE TABLE "HouseholdOwnershipTransfer" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "fromMemberId" TEXT NOT NULL,
  "toMemberId" TEXT NOT NULL,
  "status" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  "initiateOperationId" TEXT,
  "settleOperationId" TEXT,
  CONSTRAINT "HouseholdOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_householdId_fromMemberId_fkey"
  FOREIGN KEY ("householdId", "fromMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_householdId_toMemberId_fkey"
  FOREIGN KEY ("householdId", "toMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A transfer may never name the same member as both sides: handing ownership to yourself would be a
-- no-op that still burns an operation and writes a misleading audit trail.
ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_distinct_parties_check"
  CHECK ("fromMemberId" <> "toMemberId");

-- "status" is NULL while an offer is outstanding and a known settled value afterwards. The partial
-- unique index below depends entirely on that, so the set of settled values is constrained here
-- rather than left to whichever service happens to write the column.
ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_status_check"
  CHECK ("status" IS NULL OR "status" IN ('accepted', 'declined', 'cancelled', 'expired'));

-- A settled row records WHEN it settled, and an outstanding one has not settled. Keeping these two
-- columns consistent means "pending" cannot be inferred two ways that disagree.
ALTER TABLE "HouseholdOwnershipTransfer"
  ADD CONSTRAINT "HouseholdOwnershipTransfer_settled_at_check"
  CHECK (("status" IS NULL) = ("settledAt" IS NULL));

CREATE UNIQUE INDEX "HouseholdOwnershipTransfer_householdId_id_key"
  ON "HouseholdOwnershipTransfer"("householdId", "id");

CREATE UNIQUE INDEX "HouseholdOwnershipTransfer_initiateOperationId_key"
  ON "HouseholdOwnershipTransfer"("initiateOperationId");

CREATE UNIQUE INDEX "HouseholdOwnershipTransfer_settleOperationId_key"
  ON "HouseholdOwnershipTransfer"("settleOperationId");

CREATE INDEX "HouseholdOwnershipTransfer_householdId_status_idx"
  ON "HouseholdOwnershipTransfer"("householdId", "status");

CREATE INDEX "HouseholdOwnershipTransfer_householdId_toMemberId_status_idx"
  ON "HouseholdOwnershipTransfer"("householdId", "toMemberId", "status");

-- At most ONE pending transfer per household, enforced here rather than in application code so two
-- concurrent initiations cannot both succeed and leave the household facing a choice of owners.
-- A settled transfer sets "status", leaving the partial index free for the next one.
CREATE UNIQUE INDEX "HouseholdOwnershipTransfer_one_pending_per_household"
  ON "HouseholdOwnershipTransfer"("householdId")
  WHERE "status" IS NULL;

REVOKE ALL ON "HouseholdOwnershipTransfer" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "HouseholdOwnershipTransfer" TO cubby_runtime;
