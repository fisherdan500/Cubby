-- Retain only a minimal immutable receipt after deleting encrypted Sprout source bytes.
ALTER TABLE "ImportBatch"
  ADD COLUMN "rawSourceDeletedAt" TIMESTAMP(3),
  ADD COLUMN "rawSourceRetentionReceipt" JSONB,
  ADD COLUMN "rawSourceCleanupPendingAt" TIMESTAMP(3),
  ADD COLUMN "rawSourceCleanupNextRetryAt" TIMESTAMP(3),
  ADD COLUMN "rawSourceCleanupLastError" TEXT,
  ADD COLUMN "rawSourceCleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rawSourceCleanupLeaseToken" TEXT,
  ADD COLUMN "rawSourceCleanupLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "ImportBatch_sourceSystem_status_rawSourceDeletedAt_createdAt_idx"
  ON "ImportBatch"("sourceSystem", "status", "rawSourceDeletedAt", "createdAt");
CREATE INDEX "ImportBatch_sourceSystem_rawSourceCleanupNextRetryAt_idx"
  ON "ImportBatch"("sourceSystem", "rawSourceCleanupNextRetryAt");

CREATE OR REPLACE FUNCTION "prevent_completed_sprout_import_result_change"() RETURNS trigger AS $$
BEGIN
  IF OLD."completedResult" IS NOT NULL
    AND NEW."completedResult" IS DISTINCT FROM OLD."completedResult" THEN
    RAISE EXCEPTION 'completed_sprout_import_result_immutable';
  END IF;

  IF OLD."rawSourceRetentionReceipt" IS NOT NULL
    AND NEW."rawSourceRetentionReceipt" IS DISTINCT FROM OLD."rawSourceRetentionReceipt" THEN
    RAISE EXCEPTION 'sprout_source_retention_receipt_immutable';
  END IF;

  IF OLD."rawSourceDeletedAt" IS NOT NULL
    AND NEW."rawSourceDeletedAt" IS DISTINCT FROM OLD."rawSourceDeletedAt" THEN
    RAISE EXCEPTION 'sprout_source_deletion_immutable';
  END IF;

  IF NEW."rawSourceDeletedAt" IS NOT NULL AND (
    NEW."sourceFilename" IS NOT NULL
    OR NEW."sourceDigest" IS NOT NULL
    OR NEW."stagedFilename" IS NOT NULL
    OR NEW."stagedNonce" IS NOT NULL
    OR NEW."stagedAuthTag" IS NOT NULL
    OR NEW."stagedKeyVersion" IS NOT NULL
    OR (NEW."summary" IS NOT NULL AND NEW."summary" <> 'null'::jsonb)
    OR cardinality(NEW."warnings") <> 0
    OR NEW."error" IS NOT NULL
    OR NEW."rawSourceRetentionReceipt" IS NULL
  ) THEN
    RAISE EXCEPTION 'sprout_source_deletion_receipt_incomplete';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
