-- Forward-only global-account appearance preference and browser-v2 ledger.
-- Appearance mode defaults to system; no value is derived from HouseholdSettings.accentTheme.
BEGIN;

CREATE TYPE "AppearanceMode" AS ENUM ('system', 'light', 'dark');
CREATE TYPE "AccountOperationKey" AS ENUM ('account.appearance.update');

ALTER TABLE "User"
  ADD COLUMN "appearanceMode" "AppearanceMode" NOT NULL DEFAULT 'system',
  ADD COLUMN "appearanceRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "User_appearanceRevision_nonnegative_check" CHECK ("appearanceRevision" >= 0);

CREATE TABLE "AccountOperationBinding" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "AccountOperationKey" NOT NULL,
  "openingFingerprint" TEXT NOT NULL,
  "persistenceVersion" INTEGER NOT NULL DEFAULT 2,
  "targetSnapshot" JSONB NOT NULL,
  "protocolVersion" "BrowserOperationProtocolVersion" NOT NULL DEFAULT 'browser_v2',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "state" "BrowserOperationBindingState" NOT NULL DEFAULT 'open',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountOperationBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountOperationBinding_identity_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "AccountOperationBinding_opening_check" CHECK (
    "persistenceVersion" = 2
    AND "protocolVersion" = 'browser_v2'
    AND "openingFingerprint" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("targetSnapshot") = 'object'
  )
);

CREATE TABLE "AccountMutationOperation" (
  "bindingId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "AccountOperationKey" NOT NULL,
  "openingFingerprint" TEXT NOT NULL,
  "intentFingerprint" TEXT NOT NULL,
  "persistenceVersion" INTEGER NOT NULL DEFAULT 2,
  "status" "BrowserMutationOperationStatus" NOT NULL DEFAULT 'pending',
  "outcomeVersion" INTEGER,
  "outcomeKind" TEXT,
  "outcomeCode" TEXT,
  "outcomeSnapshot" JSONB,
  "auditCorrelation" TEXT,
  "terminalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountMutationOperation_pkey" PRIMARY KEY ("userId", "operationId"),
  CONSTRAINT "AccountMutationOperation_identity_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "AccountMutationOperation_fingerprint_check" CHECK (
    "persistenceVersion" = 2
    AND "openingFingerprint" ~ '^[0-9a-f]{64}$'
    AND "intentFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AccountMutationOperation_state_check" CHECK (
    ("status" IN ('pending', 'unknown') AND "terminalAt" IS NULL)
    OR ("status" IN ('completed', 'rejected', 'stale') AND "terminalAt" IS NOT NULL)
  )
);

CREATE TABLE "AccountMutationOperationTombstone" (
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "AccountOperationKey" NOT NULL,
  "intentFingerprint" TEXT NOT NULL,
  "terminalStatus" "BrowserMutationOperationStatus" NOT NULL,
  "terminalCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "terminalAt" TIMESTAMP(3) NOT NULL,
  "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "auditCorrelation" TEXT,
  CONSTRAINT "AccountMutationOperationTombstone_pkey" PRIMARY KEY ("userId", "operationId"),
  CONSTRAINT "AccountMutationOperationTombstone_identity_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "AccountMutationOperationTombstone_terminal_check" CHECK (
    "terminalStatus" IN ('completed', 'rejected', 'stale') AND length("terminalCode") > 0
  )
);

CREATE UNIQUE INDEX "AccountOperationBinding_userId_operationId_key" ON "AccountOperationBinding"("userId", "operationId");
CREATE INDEX "AccountOperationBinding_sessionId_idx" ON "AccountOperationBinding"("sessionId");
CREATE INDEX "AccountOperationBinding_state_expiresAt_idx" ON "AccountOperationBinding"("state", "expiresAt");
CREATE INDEX "AccountOperationBinding_state_updatedAt_userId_operationId_idx" ON "AccountOperationBinding"("state", "updatedAt", "userId", "operationId");
CREATE UNIQUE INDEX "AccountMutationOperation_bindingId_key" ON "AccountMutationOperation"("bindingId");
CREATE INDEX "AccountMutationOperation_status_createdAt_idx" ON "AccountMutationOperation"("status", "createdAt");
CREATE INDEX "AccountMutationOperation_terminalAt_userId_operationId_idx" ON "AccountMutationOperation"("terminalAt", "userId", "operationId");
CREATE INDEX "AccountMutationOperationTombstone_compactedAt_idx" ON "AccountMutationOperationTombstone"("compactedAt");

ALTER TABLE "AccountOperationBinding"
  ADD CONSTRAINT "AccountOperationBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountMutationOperation"
  ADD CONSTRAINT "AccountMutationOperation_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "AccountOperationBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountMutationOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountMutationOperationTombstone"
  ADD CONSTRAINT "AccountMutationOperationTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "lock_account_browser_operation_identity"(scope_ref TEXT, operation_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE identity_text TEXT := 'account-browser-operation:v1:' || scope_ref || ':' || operation_id;
BEGIN
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 1, 16))::bit(64)::bigint));
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 17, 16))::bit(64)::bigint));
END
$$;

CREATE FUNCTION "guard_account_operation_binding_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(NEW."userId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "AccountMutationOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'account_operation_identity_already_owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "guard_account_mutation_operation_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE bound "AccountOperationBinding"%ROWTYPE;
BEGIN
  PERFORM "lock_account_browser_operation_identity"(NEW."userId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'account_operation_identity_compacted' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO bound FROM "AccountOperationBinding" WHERE "id" = NEW."bindingId" FOR UPDATE;
  IF NOT FOUND
     OR bound."state" <> 'open'
     OR bound."userId" IS DISTINCT FROM NEW."userId"
     OR bound."operationId" IS DISTINCT FROM NEW."operationId"
     OR bound."operationKey" IS DISTINCT FROM NEW."operationKey"
     OR bound."openingFingerprint" IS DISTINCT FROM NEW."openingFingerprint" THEN
    RAISE EXCEPTION 'account_operation_binding_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "guard_account_operation_tombstone_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE full_operation "AccountMutationOperation"%ROWTYPE;
BEGIN
  PERFORM "lock_account_browser_operation_identity"(NEW."userId", NEW."operationId");
  SELECT * INTO full_operation FROM "AccountMutationOperation"
  WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId" FOR UPDATE;
  IF NOT FOUND
     OR full_operation."status" NOT IN ('completed', 'rejected', 'stale')
     OR full_operation."operationKey" IS DISTINCT FROM NEW."operationKey"
     OR full_operation."intentFingerprint" IS DISTINCT FROM NEW."intentFingerprint"
     OR full_operation."status" IS DISTINCT FROM NEW."terminalStatus"
     OR full_operation."outcomeCode" IS DISTINCT FROM NEW."terminalCode"
     OR full_operation."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR full_operation."terminalAt" IS DISTINCT FROM NEW."terminalAt"
     OR full_operation."auditCorrelation" IS DISTINCT FROM NEW."auditCorrelation" THEN
    RAISE EXCEPTION 'account_operation_tombstone_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountOperationBinding_identity_insert_guard" BEFORE INSERT ON "AccountOperationBinding"
FOR EACH ROW EXECUTE FUNCTION "guard_account_operation_binding_insert"();
CREATE TRIGGER "AccountMutationOperation_identity_insert_guard" BEFORE INSERT ON "AccountMutationOperation"
FOR EACH ROW EXECUTE FUNCTION "guard_account_mutation_operation_insert"();
CREATE TRIGGER "AccountMutationOperationTombstone_identity_insert_guard" BEFORE INSERT ON "AccountMutationOperationTombstone"
FOR EACH ROW EXECUTE FUNCTION "guard_account_operation_tombstone_insert"();

CREATE FUNCTION "enforce_account_operation_binding_write_once"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(OLD."userId", OLD."operationId");
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId") THEN RETURN OLD; END IF;
    IF OLD."state" IN ('expired', 'revoked')
       AND OLD."updatedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'
       AND NOT EXISTS (SELECT 1 FROM "AccountMutationOperation" WHERE "bindingId" = OLD."id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'account_operation_binding_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD."sessionId", OLD."userId", OLD."operationId", OLD."operationKey", OLD."openingFingerprint", OLD."persistenceVersion", OLD."targetSnapshot", OLD."protocolVersion", OLD."expiresAt", OLD."issuedAt")
     IS DISTINCT FROM ROW(NEW."sessionId", NEW."userId", NEW."operationId", NEW."operationKey", NEW."openingFingerprint", NEW."persistenceVersion", NEW."targetSnapshot", NEW."protocolVersion", NEW."expiresAt", NEW."issuedAt") THEN
    RAISE EXCEPTION 'account_operation_binding_authority_immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."state" = NEW."state" OR (OLD."state" = 'open' AND NEW."state" IN ('submitted', 'revoked', 'expired')) OR (OLD."state" = 'submitted' AND NEW."state" = 'terminal')) THEN
    RAISE EXCEPTION 'account_operation_binding_transition_invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'submitted' AND NOT EXISTS (SELECT 1 FROM "AccountMutationOperation" WHERE "bindingId" = NEW."id") THEN
    RAISE EXCEPTION 'account_operation_submitted_without_operation' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" = 'terminal' AND NOT EXISTS (
    SELECT 1 FROM "AccountMutationOperation" WHERE "bindingId" = NEW."id" AND "status" IN ('completed', 'rejected', 'stale')
  ) THEN RAISE EXCEPTION 'account_operation_terminal_without_result' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "AccountOperationBinding_write_once" BEFORE UPDATE OR DELETE ON "AccountOperationBinding"
FOR EACH ROW EXECUTE FUNCTION "enforce_account_operation_binding_write_once"();

CREATE FUNCTION "enforce_account_mutation_operation_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(OLD."userId", OLD."operationId");
  IF OLD."status" IN ('completed', 'rejected', 'stale') THEN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM "AccountMutationOperationTombstone" tombstone
      WHERE tombstone."userId" = OLD."userId" AND tombstone."operationId" = OLD."operationId"
        AND tombstone."intentFingerprint" = OLD."intentFingerprint"
        AND tombstone."terminalStatus" = OLD."status" AND tombstone."terminalCode" = OLD."outcomeCode"
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'terminal_account_mutation_operation_immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'unresolved_account_mutation_operation_immutable' USING ERRCODE = '55000'; END IF;
  IF ROW(OLD."bindingId", OLD."userId", OLD."operationId", OLD."operationKey", OLD."openingFingerprint", OLD."intentFingerprint", OLD."persistenceVersion", OLD."createdAt")
     IS DISTINCT FROM ROW(NEW."bindingId", NEW."userId", NEW."operationId", NEW."operationKey", NEW."openingFingerprint", NEW."intentFingerprint", NEW."persistenceVersion", NEW."createdAt") THEN
    RAISE EXCEPTION 'account_mutation_operation_intent_immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'pending' AND NEW."status" IN ('unknown', 'completed', 'rejected', 'stale')) OR (OLD."status" = 'unknown' AND NEW."status" IN ('completed', 'rejected', 'stale')) ) THEN
    RAISE EXCEPTION 'account_mutation_operation_transition_invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "AccountMutationOperation_enforce_transition" BEFORE UPDATE OR DELETE ON "AccountMutationOperation"
FOR EACH ROW EXECUTE FUNCTION "enforce_account_mutation_operation_transition"();

CREATE FUNCTION "prevent_account_operation_tombstone_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'account_operation_tombstone_immutable' USING ERRCODE = '55000'; END
$$;
CREATE TRIGGER "AccountMutationOperationTombstone_immutable" BEFORE UPDATE OR DELETE ON "AccountMutationOperationTombstone"
FOR EACH ROW EXECUTE FUNCTION "prevent_account_operation_tombstone_mutation"();

CREATE FUNCTION "compact_account_browser_operation"(scope_ref TEXT, operation_id TEXT, compacted_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE full_operation "AccountMutationOperation"%ROWTYPE;
BEGIN
  PERFORM "lock_account_browser_operation_identity"(scope_ref, operation_id);
  SELECT * INTO full_operation FROM "AccountMutationOperation"
  WHERE "userId" = scope_ref AND "operationId" = operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF full_operation."status" NOT IN ('completed', 'rejected', 'stale') OR full_operation."terminalAt" IS NULL
     OR full_operation."terminalAt" > compacted_at - INTERVAL '30 days' THEN RETURN false; END IF;
  INSERT INTO "AccountMutationOperationTombstone" (
    "userId", "operationId", "operationKey", "intentFingerprint", "terminalStatus", "terminalCode",
    "createdAt", "terminalAt", "compactedAt", "auditCorrelation"
  ) VALUES (
    full_operation."userId", full_operation."operationId", full_operation."operationKey", full_operation."intentFingerprint",
    full_operation."status", full_operation."outcomeCode", full_operation."createdAt", full_operation."terminalAt",
    compacted_at, full_operation."auditCorrelation"
  ) ON CONFLICT ("userId", "operationId") DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = scope_ref AND "operationId" = operation_id
      AND "intentFingerprint" = full_operation."intentFingerprint" AND "terminalStatus" = full_operation."status"
      AND "terminalCode" = full_operation."outcomeCode"
  ) THEN RAISE EXCEPTION 'account_operation_compaction_ambiguous' USING ERRCODE = '23514'; END IF;
  DELETE FROM "AccountMutationOperation" WHERE "userId" = scope_ref AND "operationId" = operation_id;
  DELETE FROM "AccountOperationBinding" WHERE "id" = full_operation."bindingId";
  RETURN true;
END
$$;

COMMIT;
