-- DEC-PROD-407 lifetime identity ownership for never-submitted reservations.
-- This is forward-only: existing terminal operation tombstones are unchanged.

CREATE TABLE "BrowserOperationReservationTombstone" (
  "householdId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "BrowserOperationKey" NOT NULL,
  "sessionId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorMemberId" TEXT NOT NULL,
  "openingFingerprint" TEXT NOT NULL,
  "terminalCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "terminalAt" TIMESTAMP(3) NOT NULL,
  "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrowserOperationReservationTombstone_pkey" PRIMARY KEY ("householdId", "operationId"),
  CONSTRAINT "BrowserOperationReservationTombstone_identity_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "BrowserOperationReservationTombstone_opening_check" CHECK ("openingFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BrowserOperationReservationTombstone_code_check" CHECK ("terminalCode" IN ('operation_abandoned', 'operation_result_expired'))
);
CREATE INDEX "BrowserOperationReservationTombstone_sessionId_idx" ON "BrowserOperationReservationTombstone"("sessionId");
CREATE INDEX "BrowserOperationReservationTombstone_householdId_actorMemberId_idx" ON "BrowserOperationReservationTombstone"("householdId", "actorMemberId");
CREATE INDEX "BrowserOperationReservationTombstone_compactedAt_idx" ON "BrowserOperationReservationTombstone"("compactedAt");

CREATE TABLE "AccountOperationReservationTombstone" (
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" "AccountOperationKey" NOT NULL,
  "sessionId" TEXT NOT NULL,
  "openingFingerprint" TEXT NOT NULL,
  "terminalCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "terminalAt" TIMESTAMP(3) NOT NULL,
  "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountOperationReservationTombstone_pkey" PRIMARY KEY ("userId", "operationId"),
  CONSTRAINT "AccountOperationReservationTombstone_identity_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "AccountOperationReservationTombstone_opening_check" CHECK ("openingFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountOperationReservationTombstone_code_check" CHECK ("terminalCode" IN ('operation_abandoned', 'operation_result_expired'))
);
CREATE INDEX "AccountOperationReservationTombstone_sessionId_idx" ON "AccountOperationReservationTombstone"("sessionId");
CREATE INDEX "AccountOperationReservationTombstone_compactedAt_idx" ON "AccountOperationReservationTombstone"("compactedAt");

CREATE FUNCTION "prevent_browser_operation_reservation_tombstone_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'browser_operation_reservation_tombstone_immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER "BrowserOperationReservationTombstone_immutable"
BEFORE UPDATE OR DELETE ON "BrowserOperationReservationTombstone"
FOR EACH ROW EXECUTE FUNCTION "prevent_browser_operation_reservation_tombstone_mutation"();

CREATE FUNCTION "prevent_account_operation_reservation_tombstone_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account_operation_reservation_tombstone_immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER "AccountOperationReservationTombstone_immutable"
BEFORE UPDATE OR DELETE ON "AccountOperationReservationTombstone"
FOR EACH ROW EXECUTE FUNCTION "prevent_account_operation_reservation_tombstone_mutation"();

CREATE FUNCTION "guard_browser_operation_reservation_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_household_browser_operation_identity"(NEW."householdId", NEW."operationId");
  IF NOT EXISTS (
    SELECT 1
    FROM "BrowserOperationBinding" binding
    WHERE binding."householdId" = NEW."householdId"
      AND binding."operationId" = NEW."operationId"
      AND binding."operationKey" = NEW."operationKey"
      AND binding."sessionId" = NEW."sessionId"
      AND binding."actorUserId" = NEW."actorUserId"
      AND binding."actorMemberId" = NEW."actorMemberId"
      AND binding."openingFingerprint" = NEW."openingFingerprint"
      AND binding."issuedAt" = NEW."createdAt"
      AND NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" operation WHERE operation."bindingId" = binding."id")
      AND (
        (NEW."terminalCode" = 'operation_abandoned' AND binding."state" = 'open')
        OR (NEW."terminalCode" = 'operation_result_expired' AND binding."state" IN ('expired', 'revoked'))
      )
  ) THEN
    RAISE EXCEPTION 'browser_operation_reservation_tombstone_binding_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BrowserOperationReservationTombstone_binding_guard"
BEFORE INSERT ON "BrowserOperationReservationTombstone"
FOR EACH ROW EXECUTE FUNCTION "guard_browser_operation_reservation_tombstone_insert"();

CREATE FUNCTION "guard_account_operation_reservation_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(NEW."userId", NEW."operationId");
  IF NOT EXISTS (
    SELECT 1
    FROM "AccountOperationBinding" binding
    WHERE binding."userId" = NEW."userId"
      AND binding."operationId" = NEW."operationId"
      AND binding."operationKey" = NEW."operationKey"
      AND binding."sessionId" = NEW."sessionId"
      AND binding."openingFingerprint" = NEW."openingFingerprint"
      AND binding."issuedAt" = NEW."createdAt"
      AND NOT EXISTS (SELECT 1 FROM "AccountMutationOperation" operation WHERE operation."bindingId" = binding."id")
      AND (
        (NEW."terminalCode" = 'operation_abandoned' AND binding."state" = 'open')
        OR (NEW."terminalCode" = 'operation_result_expired' AND binding."state" IN ('expired', 'revoked'))
      )
  ) THEN
    RAISE EXCEPTION 'account_operation_reservation_tombstone_binding_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AccountOperationReservationTombstone_binding_guard"
BEFORE INSERT ON "AccountOperationReservationTombstone"
FOR EACH ROW EXECUTE FUNCTION "guard_account_operation_reservation_tombstone_insert"();

CREATE OR REPLACE FUNCTION "guard_household_browser_operation_binding_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_household_browser_operation_identity"(NEW."householdId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "BrowserMutationOperation" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "BrowserMutationOperationTombstone" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "BrowserOperationReservationTombstone" WHERE "householdId" = NEW."householdId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'browser_operation_reservation_identity_already_owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "guard_account_operation_binding_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(NEW."userId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "AccountMutationOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId")
     OR EXISTS (SELECT 1 FROM "AccountOperationReservationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'account_operation_reservation_identity_already_owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_browser_operation_binding_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_household_browser_operation_identity"(OLD."householdId", OLD."operationId");
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "BrowserMutationOperationTombstone" WHERE "householdId" = OLD."householdId" AND "operationId" = OLD."operationId") THEN RETURN OLD; END IF;
    IF EXISTS (
      SELECT 1 FROM "BrowserOperationReservationTombstone" tombstone
      WHERE tombstone."householdId" = OLD."householdId"
        AND tombstone."operationId" = OLD."operationId"
        AND tombstone."operationKey" = OLD."operationKey"
        AND tombstone."sessionId" = OLD."sessionId"
        AND tombstone."actorUserId" = OLD."actorUserId"
        AND tombstone."actorMemberId" = OLD."actorMemberId"
        AND tombstone."openingFingerprint" = OLD."openingFingerprint"
        AND tombstone."createdAt" = OLD."issuedAt"
        AND NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" operation WHERE operation."bindingId" = OLD."id")
        AND (
          (tombstone."terminalCode" = 'operation_abandoned' AND OLD."state" = 'open')
          OR (tombstone."terminalCode" = 'operation_result_expired' AND OLD."state" IN ('expired', 'revoked'))
        )
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'browser_operation_binding_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD."sessionId", OLD."actorUserId", OLD."actorMemberId", OLD."householdId", OLD."operationId", OLD."operationKey", OLD."intentFingerprint", OLD."openingFingerprint", OLD."persistenceVersion", OLD."targetKind", OLD."targetId", OLD."babyId", OLD."targetSnapshot", OLD."protocolVersion", OLD."expiresAt", OLD."issuedAt")
     IS DISTINCT FROM ROW(NEW."sessionId", NEW."actorUserId", NEW."actorMemberId", NEW."householdId", NEW."operationId", NEW."operationKey", NEW."intentFingerprint", NEW."openingFingerprint", NEW."persistenceVersion", NEW."targetKind", NEW."targetId", NEW."babyId", NEW."targetSnapshot", NEW."protocolVersion", NEW."expiresAt", NEW."issuedAt") THEN
    RAISE EXCEPTION 'browser_operation_binding_authority_immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."state" = NEW."state" OR (OLD."state" = 'open' AND NEW."state" IN ('submitted', 'revoked', 'expired')) OR (OLD."state" = 'submitted' AND NEW."state" = 'terminal')) THEN
    RAISE EXCEPTION 'browser_operation_binding_transition_invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'submitted' AND NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" WHERE "bindingId" = NEW."id") THEN
    RAISE EXCEPTION 'browser_operation_submitted_without_operation' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" = 'terminal' AND NOT EXISTS (
    SELECT 1 FROM "BrowserMutationOperation"
    WHERE "bindingId" = NEW."id" AND "status" IN ('completed', 'rejected', 'stale')
  ) THEN
    RAISE EXCEPTION 'browser_operation_terminal_without_terminal_operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_account_operation_binding_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_account_browser_operation_identity"(OLD."userId", OLD."operationId");
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "AccountMutationOperationTombstone" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId") THEN RETURN OLD; END IF;
    IF EXISTS (
      SELECT 1 FROM "AccountOperationReservationTombstone" tombstone
      WHERE tombstone."userId" = OLD."userId"
        AND tombstone."operationId" = OLD."operationId"
        AND tombstone."operationKey" = OLD."operationKey"
        AND tombstone."sessionId" = OLD."sessionId"
        AND tombstone."openingFingerprint" = OLD."openingFingerprint"
        AND tombstone."createdAt" = OLD."issuedAt"
        AND NOT EXISTS (SELECT 1 FROM "AccountMutationOperation" operation WHERE operation."bindingId" = OLD."id")
        AND (
          (tombstone."terminalCode" = 'operation_abandoned' AND OLD."state" = 'open')
          OR (tombstone."terminalCode" = 'operation_result_expired' AND OLD."state" IN ('expired', 'revoked'))
        )
    ) THEN RETURN OLD; END IF;
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
    SELECT 1 FROM "AccountMutationOperation"
    WHERE "bindingId" = NEW."id" AND "status" IN ('completed', 'rejected', 'stale')
  ) THEN
    RAISE EXCEPTION 'account_operation_terminal_without_terminal_operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
