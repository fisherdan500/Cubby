-- Forward-only household browser-v2 persistence foundation.
-- Existing browser_v1 and persistenceVersion 1 rows are not rewritten or reinterpreted.
BEGIN;

-- Deterministic read-only preflight against the currently deployed pilot shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "BrowserMutationOperation" operation
    LEFT JOIN "BrowserOperationBinding" binding ON binding."id" = operation."bindingId"
    WHERE binding."id" IS NULL
       OR binding."householdId" IS DISTINCT FROM operation."householdId"
       OR binding."operationId" IS DISTINCT FROM operation."operationId"
       OR binding."operationKey" IS DISTINCT FROM operation."operationKey"
       OR binding."actorUserId" IS DISTINCT FROM operation."actorUserId"
       OR binding."actorMemberId" IS DISTINCT FROM operation."actorMemberId"
       OR binding."intentFingerprint" IS DISTINCT FROM operation."intentFingerprint"
       OR binding."babyId" IS DISTINCT FROM operation."babyId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_foundation_preflight_failed:operation_binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding"
    WHERE "operationId" !~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'
       OR "intentFingerprint" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_foundation_preflight_failed:legacy_binding_shape';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation"
    WHERE "operationId" !~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'
       OR "intentFingerprint" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_foundation_preflight_failed:legacy_operation_shape';
  END IF;
END
$$;

COMMIT;

-- PostgreSQL enum additions are committed before later constraints refer to them.
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.delete';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.undo_last';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.pause';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.resume';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.stop';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'baby.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.revoke';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.revoke_all';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.restore';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.remove';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.role.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.suspend';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'notification.preference.save';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'settings.units.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'household.accent.update';

BEGIN;

CREATE TYPE "BrowserOperationTargetKind" AS ENUM (
  'household', 'activity', 'baby', 'warning', 'invite', 'member', 'preference', 'settings', 'calendar'
);

ALTER TABLE "BrowserOperationBinding"
  ALTER COLUMN "intentFingerprint" DROP NOT NULL,
  ADD COLUMN "openingFingerprint" TEXT,
  ADD COLUMN "persistenceVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "targetKind" "BrowserOperationTargetKind",
  ADD COLUMN "targetId" TEXT;

ALTER TABLE "BrowserMutationOperation"
  ADD COLUMN "openingFingerprint" TEXT,
  ADD COLUMN "persistenceVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "targetKind" "BrowserOperationTargetKind",
  ADD COLUMN "targetId" TEXT,
  ADD COLUMN "auditCorrelation" TEXT;

CREATE TABLE "BrowserMutationOperationTombstone" (
  "householdId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "BrowserOperationKey" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorMemberId" TEXT NOT NULL,
  "intentFingerprint" TEXT NOT NULL,
  "terminalStatus" "BrowserMutationOperationStatus" NOT NULL,
  "terminalCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "terminalAt" TIMESTAMP(3) NOT NULL,
  "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "auditCorrelation" TEXT,
  CONSTRAINT "BrowserMutationOperationTombstone_pkey" PRIMARY KEY ("householdId", "operationId"),
  CONSTRAINT "BrowserMutationOperationTombstone_operationId_check"
    CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "BrowserMutationOperationTombstone_terminal_check"
    CHECK ("terminalStatus" IN ('completed', 'rejected', 'stale') AND length("terminalCode") > 0)
);

CREATE INDEX "BrowserMutationOperationTombstone_householdId_actorMemberId_idx"
  ON "BrowserMutationOperationTombstone"("householdId", "actorMemberId");
CREATE INDEX "BrowserMutationOperationTombstone_compactedAt_idx"
  ON "BrowserMutationOperationTombstone"("compactedAt");
CREATE INDEX "BrowserMutationOperation_terminalAt_householdId_operationId_idx"
  ON "BrowserMutationOperation"("terminalAt", "householdId", "operationId");
CREATE INDEX "BrowserOperationBinding_state_updatedAt_householdId_operationId_idx"
  ON "BrowserOperationBinding"("state", "updatedAt", "householdId", "operationId");

ALTER TABLE "BrowserMutationOperationTombstone"
  ADD CONSTRAINT "BrowserMutationOperationTombstone_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BrowserMutationOperationTombstone_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BrowserMutationOperationTombstone_householdId_actorMemberId_fkey"
  FOREIGN KEY ("householdId", "actorMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BrowserOperationBinding"
  ADD CONSTRAINT "BrowserOperationBinding_two_stage_check" CHECK (
    ("persistenceVersion" = 1 AND "openingFingerprint" IS NULL AND "targetKind" IS NULL AND "targetId" IS NULL)
    OR
    ("persistenceVersion" = 2
      AND "protocolVersion" = 'browser_v2'
      AND "intentFingerprint" IS NULL
      AND "openingFingerprint" ~ '^[0-9a-f]{64}$'
      AND "targetKind" IS NOT NULL
      AND jsonb_typeof("targetSnapshot") = 'object')
  ),
  ADD CONSTRAINT "BrowserOperationBinding_target_shape_check" CHECK (
    "persistenceVersion" = 1 OR
    CASE "operationKey"::text
      WHEN 'activity.create' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
      WHEN 'activity.update' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.delete' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.undo_last' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.pause' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.resume' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'activity.timer.stop' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'baby.create' THEN "targetKind" = 'baby' AND "targetId" IS NULL AND "babyId" IS NULL
      WHEN 'baby.deactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
      WHEN 'baby.reactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
      WHEN 'dashboard.warning.dismiss' THEN "targetKind" = 'warning' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
      WHEN 'invite.create' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
      WHEN 'invite.revoke' THEN "targetKind" = 'invite' AND "targetId" IS NOT NULL AND "babyId" IS NULL
      WHEN 'invite.revoke_all' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
      WHEN 'member.restore' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
      WHEN 'member.remove' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
      WHEN 'member.role.update' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
      WHEN 'member.suspend' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
      WHEN 'notification.preference.save' THEN "targetKind" = 'preference' AND "targetId" IS NULL AND "babyId" IS NULL
      WHEN 'settings.units.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
      WHEN 'calendar_event.create' THEN "targetKind" = 'calendar' AND "targetId" IS NULL AND "babyId" IS NOT NULL
      WHEN 'household.accent.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
      ELSE false
    END
  );

ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_two_stage_check" CHECK (
    ("persistenceVersion" = 1 AND "openingFingerprint" IS NULL AND "targetKind" IS NULL AND "targetId" IS NULL)
    OR
    ("persistenceVersion" = 2
      AND "openingFingerprint" ~ '^[0-9a-f]{64}$'
      AND "intentFingerprint" ~ '^[0-9a-f]{64}$'
      AND "targetKind" IS NOT NULL)
  ),
  ADD CONSTRAINT "BrowserMutationOperation_state_check" CHECK (
    ("status" IN ('pending', 'unknown') AND "terminalAt" IS NULL)
    OR
    ("status" IN ('completed', 'rejected', 'stale') AND "terminalAt" IS NOT NULL)
  );

CREATE FUNCTION "lock_household_browser_operation_identity"(scope_ref TEXT, operation_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  identity_text TEXT := 'household-browser-operation:v1:' || scope_ref || ':' || operation_id;
BEGIN
  -- Two independent 64-bit halves make accidental digest aliasing over-serialize
  -- rather than permit an identity gap.
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 1, 16))::bit(64)::bigint));
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 17, 16))::bit(64)::bigint));
END
$$;

CREATE FUNCTION "guard_household_browser_operation_binding_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "lock_household_browser_operation_identity"(NEW."householdId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "BrowserMutationOperation" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "BrowserMutationOperationTombstone" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'browser_operation_identity_already_owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "guard_household_browser_mutation_operation_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  bound "BrowserOperationBinding"%ROWTYPE;
BEGIN
  PERFORM "lock_household_browser_operation_identity"(NEW."householdId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "BrowserMutationOperationTombstone" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'browser_operation_identity_compacted' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO bound FROM "BrowserOperationBinding" WHERE "id" = NEW."bindingId" FOR UPDATE;
  IF NOT FOUND
     OR bound."persistenceVersion" <> 2
     OR bound."state" <> 'open'
     OR bound."householdId" IS DISTINCT FROM NEW."householdId"
     OR bound."operationId" IS DISTINCT FROM NEW."operationId"
     OR bound."operationKey" IS DISTINCT FROM NEW."operationKey"
     OR bound."actorUserId" IS DISTINCT FROM NEW."actorUserId"
     OR bound."actorMemberId" IS DISTINCT FROM NEW."actorMemberId"
     OR bound."openingFingerprint" IS DISTINCT FROM NEW."openingFingerprint"
     OR bound."targetKind" IS DISTINCT FROM NEW."targetKind"
     OR bound."targetId" IS DISTINCT FROM NEW."targetId"
     OR bound."babyId" IS DISTINCT FROM NEW."babyId" THEN
    RAISE EXCEPTION 'browser_operation_binding_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "guard_household_browser_operation_tombstone_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  full_operation "BrowserMutationOperation"%ROWTYPE;
BEGIN
  PERFORM "lock_household_browser_operation_identity"(NEW."householdId", NEW."operationId");
  SELECT * INTO full_operation
  FROM "BrowserMutationOperation"
  WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId"
  FOR UPDATE;
  IF NOT FOUND
     OR full_operation."status" NOT IN ('completed', 'rejected', 'stale')
     OR full_operation."operationKey" IS DISTINCT FROM NEW."operationKey"
     OR full_operation."actorUserId" IS DISTINCT FROM NEW."actorUserId"
     OR full_operation."actorMemberId" IS DISTINCT FROM NEW."actorMemberId"
     OR full_operation."intentFingerprint" IS DISTINCT FROM NEW."intentFingerprint"
     OR full_operation."status" IS DISTINCT FROM NEW."terminalStatus"
     OR full_operation."outcomeCode" IS DISTINCT FROM NEW."terminalCode"
     OR full_operation."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR full_operation."terminalAt" IS DISTINCT FROM NEW."terminalAt"
     OR full_operation."auditCorrelation" IS DISTINCT FROM NEW."auditCorrelation" THEN
    RAISE EXCEPTION 'browser_operation_tombstone_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BrowserOperationBinding_identity_insert_guard"
BEFORE INSERT ON "BrowserOperationBinding"
FOR EACH ROW EXECUTE FUNCTION "guard_household_browser_operation_binding_insert"();
CREATE TRIGGER "BrowserMutationOperation_identity_insert_guard"
BEFORE INSERT ON "BrowserMutationOperation"
FOR EACH ROW EXECUTE FUNCTION "guard_household_browser_mutation_operation_insert"();
CREATE TRIGGER "BrowserMutationOperationTombstone_identity_insert_guard"
BEFORE INSERT ON "BrowserMutationOperationTombstone"
FOR EACH ROW EXECUTE FUNCTION "guard_household_browser_operation_tombstone_insert"();

CREATE FUNCTION "enforce_browser_operation_binding_write_once"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."persistenceVersion" <> 2 THEN RETURN NEW; END IF;
  PERFORM "lock_household_browser_operation_identity"(OLD."householdId", OLD."operationId");
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "BrowserMutationOperationTombstone" WHERE "householdId" = OLD."householdId" AND "operationId" = OLD."operationId") THEN
      RETURN OLD;
    END IF;
    IF OLD."state" IN ('expired', 'revoked')
       AND OLD."updatedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'
       AND NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" WHERE "bindingId" = OLD."id") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'browser_operation_binding_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD."sessionId", OLD."actorUserId", OLD."actorMemberId", OLD."householdId", OLD."operationId", OLD."operationKey", OLD."intentFingerprint", OLD."openingFingerprint", OLD."persistenceVersion", OLD."targetKind", OLD."targetId", OLD."babyId", OLD."targetSnapshot", OLD."protocolVersion", OLD."expiresAt", OLD."issuedAt")
     IS DISTINCT FROM
     ROW(NEW."sessionId", NEW."actorUserId", NEW."actorMemberId", NEW."householdId", NEW."operationId", NEW."operationKey", NEW."intentFingerprint", NEW."openingFingerprint", NEW."persistenceVersion", NEW."targetKind", NEW."targetId", NEW."babyId", NEW."targetSnapshot", NEW."protocolVersion", NEW."expiresAt", NEW."issuedAt") THEN
    RAISE EXCEPTION 'browser_operation_binding_authority_immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD."state" = NEW."state"
    OR (OLD."state" = 'open' AND NEW."state" IN ('submitted', 'revoked', 'expired'))
    OR (OLD."state" = 'submitted' AND NEW."state" = 'terminal')
  ) THEN
    RAISE EXCEPTION 'browser_operation_binding_transition_invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'submitted' AND NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" WHERE "bindingId" = NEW."id") THEN
    RAISE EXCEPTION 'browser_operation_submitted_without_operation' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" = 'terminal' AND NOT EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" WHERE "bindingId" = NEW."id" AND "status" IN ('completed', 'rejected', 'stale')
  ) THEN
    RAISE EXCEPTION 'browser_operation_terminal_without_result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BrowserOperationBinding_write_once"
BEFORE UPDATE OR DELETE ON "BrowserOperationBinding"
FOR EACH ROW EXECUTE FUNCTION "enforce_browser_operation_binding_write_once"();

DROP TRIGGER "BrowserMutationOperation_prevent_terminal_mutation" ON "BrowserMutationOperation";

CREATE FUNCTION "enforce_browser_mutation_operation_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "lock_household_browser_operation_identity"(OLD."householdId", OLD."operationId");
  IF OLD."status" IN ('completed', 'rejected', 'stale') THEN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM "BrowserMutationOperationTombstone" tombstone
      WHERE tombstone."householdId" = OLD."householdId"
        AND tombstone."operationId" = OLD."operationId"
        AND tombstone."intentFingerprint" = OLD."intentFingerprint"
        AND tombstone."terminalStatus" = OLD."status"
        AND tombstone."terminalCode" = OLD."outcomeCode"
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'terminal_browser_mutation_operation_immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'unresolved_browser_mutation_operation_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."persistenceVersion" = 2 AND (
    ROW(OLD."bindingId", OLD."householdId", OLD."operationId", OLD."operationKey", OLD."actorUserId", OLD."actorMemberId", OLD."openingFingerprint", OLD."intentFingerprint", OLD."persistenceVersion", OLD."targetKind", OLD."targetId", OLD."babyId", OLD."createdAt")
    IS DISTINCT FROM
    ROW(NEW."bindingId", NEW."householdId", NEW."operationId", NEW."operationKey", NEW."actorUserId", NEW."actorMemberId", NEW."openingFingerprint", NEW."intentFingerprint", NEW."persistenceVersion", NEW."targetKind", NEW."targetId", NEW."babyId", NEW."createdAt")
  ) THEN
    RAISE EXCEPTION 'browser_mutation_operation_intent_immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD."status" = NEW."status"
    OR (OLD."status" = 'pending' AND NEW."status" IN ('unknown', 'completed', 'rejected', 'stale'))
    OR (OLD."status" = 'unknown' AND NEW."status" IN ('completed', 'rejected', 'stale'))
  ) THEN
    RAISE EXCEPTION 'browser_mutation_operation_transition_invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BrowserMutationOperation_enforce_transition"
BEFORE UPDATE OR DELETE ON "BrowserMutationOperation"
FOR EACH ROW EXECUTE FUNCTION "enforce_browser_mutation_operation_transition"();

CREATE FUNCTION "prevent_browser_operation_tombstone_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'browser_operation_tombstone_immutable' USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER "BrowserMutationOperationTombstone_immutable"
BEFORE UPDATE OR DELETE ON "BrowserMutationOperationTombstone"
FOR EACH ROW EXECUTE FUNCTION "prevent_browser_operation_tombstone_mutation"();

CREATE FUNCTION "compact_household_browser_operation"(scope_ref TEXT, operation_id TEXT, compacted_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  full_operation "BrowserMutationOperation"%ROWTYPE;
BEGIN
  PERFORM "lock_household_browser_operation_identity"(scope_ref, operation_id);
  SELECT * INTO full_operation
  FROM "BrowserMutationOperation"
  WHERE "householdId" = scope_ref AND "operationId" = operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF full_operation."status" NOT IN ('completed', 'rejected', 'stale')
     OR full_operation."terminalAt" IS NULL
     OR full_operation."terminalAt" > compacted_at - INTERVAL '30 days' THEN
    RETURN false;
  END IF;

  INSERT INTO "BrowserMutationOperationTombstone" (
    "householdId", "operationId", "operationKey", "actorUserId", "actorMemberId",
    "intentFingerprint", "terminalStatus", "terminalCode", "createdAt", "terminalAt",
    "compactedAt", "auditCorrelation"
  ) VALUES (
    full_operation."householdId", full_operation."operationId", full_operation."operationKey",
    full_operation."actorUserId", full_operation."actorMemberId", full_operation."intentFingerprint",
    full_operation."status", full_operation."outcomeCode", full_operation."createdAt",
    full_operation."terminalAt", compacted_at, full_operation."auditCorrelation"
  ) ON CONFLICT ("householdId", "operationId") DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM "BrowserMutationOperationTombstone"
    WHERE "householdId" = scope_ref AND "operationId" = operation_id
      AND "intentFingerprint" = full_operation."intentFingerprint"
      AND "terminalStatus" = full_operation."status"
      AND "terminalCode" = full_operation."outcomeCode"
  ) THEN
    RAISE EXCEPTION 'browser_operation_compaction_ambiguous' USING ERRCODE = '23514';
  END IF;

  DELETE FROM "BrowserMutationOperation"
  WHERE "householdId" = scope_ref AND "operationId" = operation_id;
  DELETE FROM "BrowserOperationBinding"
  WHERE "id" = full_operation."bindingId";
  RETURN true;
END
$$;

COMMIT;
