-- Persist the exact uploaded source digest for a preview-to-import staging record.
ALTER TABLE "ImportBatch"
  ADD COLUMN "sourceDigest" TEXT,
  ADD COLUMN "stagedFilename" TEXT,
  ADD COLUMN "stagedNonce" TEXT,
  ADD COLUMN "stagedAuthTag" TEXT,
  ADD COLUMN "stagedKeyVersion" TEXT;

-- Preserve the exact completed import response for durable retry replay.
ALTER TABLE "ImportBatch"
  ADD COLUMN "completedResult" JSONB;

CREATE FUNCTION "prevent_completed_sprout_import_result_change"() RETURNS trigger AS $$
BEGIN
  IF OLD."completedResult" IS NOT NULL AND NEW."completedResult" IS DISTINCT FROM OLD."completedResult" THEN
    RAISE EXCEPTION 'completed_sprout_import_result_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImportBatch_completedResult_immutable"
  BEFORE UPDATE ON "ImportBatch"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_completed_sprout_import_result_change"();
