BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ImportedRecord" AS record
    LEFT JOIN "ImportBatch" AS batch ON batch."id" = record."importBatchId"
    WHERE batch."id" IS NULL
      OR record."householdId" <> batch."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:imported_record_import_batch';
  END IF;
END
$$;

ALTER TABLE "ImportBatch"
  ADD CONSTRAINT "ImportBatch_householdId_id_key" UNIQUE ("householdId", "id");

ALTER TABLE "ImportedRecord"
  ADD CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey"
  FOREIGN KEY ("householdId", "importBatchId")
  REFERENCES "ImportBatch" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ImportedRecord"
  VALIDATE CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey";

COMMIT;
