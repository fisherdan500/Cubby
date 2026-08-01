-- Previewed Sprout data must be committed using the same parser, mapping, and temporal context.
-- Keep these nullable so legacy previews fail closed in the service instead of receiving invented bindings.
ALTER TABLE "ImportBatch"
  ADD COLUMN "parserAdapterVersion" TEXT,
  ADD COLUMN "mappingOptionsFingerprint" TEXT,
  ADD COLUMN "contextFingerprint" TEXT;
