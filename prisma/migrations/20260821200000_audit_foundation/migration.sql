BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "AuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "actorUserSnapshot" TEXT,
  ADD COLUMN "actorMemberSnapshot" TEXT,
  ADD COLUMN "chainOrder" INTEGER,
  ADD COLUMN "previousHash" TEXT,
  ADD COLUMN "eventHash" TEXT;

ALTER TABLE "PlatformAuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "actorUserSnapshot" TEXT,
  ADD COLUMN "chainOrder" INTEGER,
  ADD COLUMN "previousHash" TEXT,
  ADD COLUMN "eventHash" TEXT;

CREATE FUNCTION "canonical_audit_json"(value JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{' || COALESCE((
      SELECT string_agg(to_json(key)::TEXT || ':' || "canonical_audit_json"(child), ',' ORDER BY octet_length(convert_to(key, 'UTF8')), convert_to(key, 'UTF8'))
      FROM jsonb_each(value) AS entry(key, child)
    ), '') || '}'
    WHEN 'array' THEN '[' || COALESCE((
      SELECT string_agg("canonical_audit_json"(child), ',' ORDER BY ordinality)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(child, ordinality)
    ), '') || ']'
    WHEN 'number' THEN trim_scale((value #>> '{}')::NUMERIC)::TEXT
    ELSE value::TEXT
  END;
$$;

CREATE FUNCTION "audit_json_numbers_are_float8"(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  child JSONB;
  numeric_value NUMERIC;
BEGIN
  IF jsonb_typeof(value) = 'number' THEN
    BEGIN
      numeric_value := (value #>> '{}')::NUMERIC;
      RETURN numeric_value = trunc(numeric_value)
        AND abs(numeric_value) <= 9007199254740991;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN false;
    END;
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    FOR child IN SELECT entry.child FROM jsonb_array_elements(value) AS entry(child) LOOP
      IF NOT "audit_json_numbers_are_float8"(child) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'object' THEN
    FOR child IN SELECT entry.child FROM jsonb_each(value) AS entry(key, child) LOOP
      IF NOT "audit_json_numbers_are_float8"(child) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

DO $$
DECLARE
  audit_row RECORD;
  previous_household_id TEXT := NULL;
  previous_hash TEXT := NULL;
  chain_order INTEGER := 0;
  next_hash TEXT;
  envelope TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AuditEvent"
    WHERE NOT "audit_json_numbers_are_float8"(before)
       OR NOT "audit_json_numbers_are_float8"(after)
  ) OR EXISTS (
    SELECT 1 FROM "PlatformAuditEvent"
    WHERE NOT "audit_json_numbers_are_float8"(before)
       OR NOT "audit_json_numbers_are_float8"(after)
  ) THEN
    RAISE EXCEPTION 'audit_legacy_numeric_unsupported';
  END IF;
  FOR audit_row IN
    SELECT id, "householdId", action, "entityType", "entityId", "createdAt", before, after
    FROM "AuditEvent"
    ORDER BY "householdId", "createdAt", id
  LOOP
    IF previous_household_id IS DISTINCT FROM audit_row."householdId" THEN
      previous_household_id := audit_row."householdId";
      previous_hash := NULL;
      chain_order := 0;
    END IF;
    chain_order := chain_order + 1;
    envelope := '{"event":{"id":' || to_json(audit_row.id)::TEXT
      || ',"after":' || COALESCE("canonical_audit_json"(audit_row.after), 'null')
      || ',"action":' || to_json(audit_row.action)::TEXT
      || ',"before":' || COALESCE("canonical_audit_json"(audit_row.before), 'null')
      || ',"entityId":' || to_json(audit_row."entityId")::TEXT
      || ',"createdAt":' || to_json(to_char(audit_row."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::TEXT
      || ',"entityType":' || to_json(audit_row."entityType")::TEXT
      || ',"householdId":' || to_json(audit_row."householdId")::TEXT
      || ',"schemaVersion":1},"previousHash":' || COALESCE(to_json(previous_hash)::TEXT, 'null') || '}';
    next_hash := encode(digest(envelope, 'sha256'), 'hex');
    UPDATE "AuditEvent"
      SET "chainOrder" = chain_order, "previousHash" = previous_hash, "eventHash" = next_hash
      WHERE id = audit_row.id;
    previous_hash := next_hash;
  END LOOP;

  previous_hash := NULL;
  chain_order := 0;
  FOR audit_row IN
    SELECT id, action, "entityType", "entityId", "createdAt", before, after
    FROM "PlatformAuditEvent"
    ORDER BY "createdAt", id
  LOOP
    chain_order := chain_order + 1;
    envelope := '{"event":{"id":' || to_json(audit_row.id)::TEXT
      || ',"after":' || COALESCE("canonical_audit_json"(audit_row.after), 'null')
      || ',"action":' || to_json(audit_row.action)::TEXT
      || ',"before":' || COALESCE("canonical_audit_json"(audit_row.before), 'null')
      || ',"entityId":' || to_json(audit_row."entityId")::TEXT
      || ',"createdAt":' || to_json(to_char(audit_row."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::TEXT
      || ',"entityType":' || to_json(audit_row."entityType")::TEXT
      || ',"householdId":"platform"'
      || ',"schemaVersion":1},"previousHash":' || COALESCE(to_json(previous_hash)::TEXT, 'null') || '}';
    next_hash := encode(digest(envelope, 'sha256'), 'hex');
    UPDATE "PlatformAuditEvent"
      SET "chainOrder" = chain_order, "previousHash" = previous_hash, "eventHash" = next_hash
      WHERE id = audit_row.id;
    previous_hash := next_hash;
  END LOOP;
END;
$$;

ALTER TABLE "AuditEvent" ALTER COLUMN "chainOrder" SET NOT NULL;
ALTER TABLE "PlatformAuditEvent" ALTER COLUMN "chainOrder" SET NOT NULL;
CREATE UNIQUE INDEX "AuditEvent_householdId_chainOrder_key" ON "AuditEvent"("householdId", "chainOrder");
CREATE UNIQUE INDEX "PlatformAuditEvent_chainOrder_key" ON "PlatformAuditEvent"("chainOrder");

DROP FUNCTION "canonical_audit_json"(JSONB);
DROP FUNCTION "audit_json_numbers_are_float8"(JSONB);

CREATE INDEX "AuditEvent_eventHash_idx" ON "AuditEvent"("eventHash");
CREATE INDEX "PlatformAuditEvent_eventHash_idx" ON "PlatformAuditEvent"("eventHash");

CREATE TABLE "AuditIntegrityCheckpoint" (
  "scope" TEXT NOT NULL,
  "headHash" TEXT NOT NULL,
  "eventCount" INTEGER NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditIntegrityCheckpoint_pkey" PRIMARY KEY ("scope"),
  CONSTRAINT "AuditIntegrityCheckpoint_eventCount_check" CHECK ("eventCount" >= 0),
  CONSTRAINT "AuditIntegrityCheckpoint_headHash_check" CHECK ("headHash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "AuditIntegrityCheckpoint_verifiedAt_idx" ON "AuditIntegrityCheckpoint"("verifiedAt");

INSERT INTO "AuditIntegrityCheckpoint" ("scope", "headHash", "eventCount", "verifiedAt")
SELECT
  'household:' || household.id,
  COALESCE(
    (array_agg(audit."eventHash" ORDER BY audit."chainOrder" DESC)
      FILTER (WHERE audit."eventHash" IS NOT NULL))[1],
    repeat('0', 64)
  ),
  COUNT(audit.id)::INTEGER,
  CURRENT_TIMESTAMP
FROM "Household" household
LEFT JOIN "AuditEvent" audit ON audit."householdId" = household.id
WHERE household."deletedAt" IS NULL
GROUP BY household.id;

INSERT INTO "AuditIntegrityCheckpoint" ("scope", "headHash", "eventCount", "verifiedAt")
SELECT
  'platform',
  COALESCE(
    (array_agg("eventHash" ORDER BY "chainOrder" DESC)
      FILTER (WHERE "eventHash" IS NOT NULL))[1],
    repeat('0', 64)
  ),
  COUNT(id)::INTEGER,
  CURRENT_TIMESTAMP
FROM "PlatformAuditEvent";

CREATE TABLE "HouseholdDeletionRegistry" (
  "householdReferenceDigest" TEXT NOT NULL,
  "auditEventCount" INTEGER NOT NULL,
  "purgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HouseholdDeletionRegistry_pkey" PRIMARY KEY ("householdReferenceDigest"),
  CONSTRAINT "HouseholdDeletionRegistry_auditEventCount_check" CHECK ("auditEventCount" >= 0),
  CONSTRAINT "HouseholdDeletionRegistry_householdReferenceDigest_check" CHECK ("householdReferenceDigest" ~ '^[a-f0-9]{32}$')
);
CREATE INDEX "HouseholdDeletionRegistry_purgedAt_idx" ON "HouseholdDeletionRegistry"("purgedAt");

CREATE FUNCTION "register_household_audit_purge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "HouseholdDeletionRegistry" ("householdReferenceDigest", "auditEventCount")
  SELECT md5(OLD.id), COUNT(*)::INTEGER
  FROM "AuditEvent"
  WHERE "householdId" = OLD.id
  ON CONFLICT ("householdReferenceDigest") DO NOTHING;
  DELETE FROM "AuditIntegrityCheckpoint" WHERE "scope" = 'household:' || OLD.id;
  RETURN OLD;
END;
$$;

CREATE FUNCTION "prevent_audit_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME = 'AuditEvent'
     AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM "Household" WHERE id = OLD."householdId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event_append_only';
END;
$$;

CREATE FUNCTION "prevent_platform_audit_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_event_append_only';
END;
$$;

CREATE FUNCTION "prevent_audit_event_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event_append_only';
END;
$$;

CREATE TRIGGER "Household_audit_purge_context"
BEFORE DELETE ON "Household"
FOR EACH ROW EXECUTE FUNCTION "register_household_audit_purge"();

CREATE TRIGGER "AuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();

CREATE TRIGGER "PlatformAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_audit_event_mutation"();

CREATE TRIGGER "AuditEvent_no_truncate"
BEFORE TRUNCATE ON "AuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_audit_event_truncate"();

CREATE TRIGGER "PlatformAuditEvent_no_truncate"
BEFORE TRUNCATE ON "PlatformAuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_audit_event_truncate"();

COMMIT;
