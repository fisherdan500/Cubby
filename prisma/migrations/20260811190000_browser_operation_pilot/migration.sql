-- Forward-only pilot persistence is applied atomically with its relationship preflight.
BEGIN;

CREATE TYPE "BrowserOperationKey" AS ENUM ('calendar_event.create', 'dashboard.warning.dismiss');
CREATE TYPE "BrowserOperationBindingState" AS ENUM ('open', 'submitted', 'revoked', 'expired', 'terminal');
CREATE TYPE "BrowserMutationOperationStatus" AS ENUM ('pending', 'completed', 'rejected', 'stale', 'unknown');

CREATE TABLE "BrowserOperationBinding" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorMemberId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationKey" "BrowserOperationKey" NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "babyId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "state" "BrowserOperationBindingState" NOT NULL DEFAULT 'open',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserOperationBinding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BrowserOperationBinding_operationId_check"
      CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$')
);

CREATE TABLE "BrowserMutationOperation" (
    "bindingId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationKey" "BrowserOperationKey" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorMemberId" TEXT NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "babyId" TEXT,
    "status" "BrowserMutationOperationStatus" NOT NULL DEFAULT 'pending',
    "outcomeVersion" INTEGER,
    "outcomeKind" TEXT,
    "outcomeCode" TEXT,
    "outcomeSnapshot" JSONB,
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserMutationOperation_pkey" PRIMARY KEY ("householdId", "operationId"),
    CONSTRAINT "BrowserMutationOperation_operationId_check"
      CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
    CONSTRAINT "BrowserMutationOperation_terminal_outcome_check" CHECK (
      ("status" IN ('pending', 'unknown') AND "outcomeVersion" IS NULL AND "outcomeKind" IS NULL AND "outcomeCode" IS NULL AND "outcomeSnapshot" IS NULL AND "terminalAt" IS NULL)
      OR
      ("status" = 'completed' AND "outcomeVersion" = 1 AND "outcomeKind" IS NOT NULL AND "outcomeCode" IS NOT NULL AND "outcomeSnapshot" IS NOT NULL AND "terminalAt" IS NOT NULL)
      OR
      ("status" IN ('rejected', 'stale') AND "outcomeVersion" = 1 AND "outcomeKind" IS NOT NULL AND "outcomeCode" IS NOT NULL AND "outcomeSnapshot" IS NULL AND "terminalAt" IS NOT NULL)
    )
);

-- Read-only relationship preflight. The new tables are empty on first application;
-- these checks document and fail closed on every relationship expected by the FKs
-- and by the later transaction-time actor/binding verification.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding" AS binding
    LEFT JOIN "Household" AS household ON household."id" = binding."householdId"
    WHERE household."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:binding_household';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding" AS binding
    LEFT JOIN "User" AS actor ON actor."id" = binding."actorUserId"
    WHERE actor."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:binding_actor_user';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding" AS binding
    LEFT JOIN "Session" AS session ON session."id" = binding."sessionId"
    WHERE session."id" IS NULL OR session."userId" <> binding."actorUserId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:binding_session_actor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding" AS binding
    LEFT JOIN "HouseholdMember" AS member ON member."id" = binding."actorMemberId"
    WHERE member."id" IS NULL OR member."householdId" <> binding."householdId" OR member."userId" <> binding."actorUserId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:binding_member_actor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserOperationBinding" AS binding
    LEFT JOIN "Baby" AS baby ON baby."id" = binding."babyId"
    WHERE binding."babyId" IS NOT NULL AND (baby."id" IS NULL OR baby."householdId" <> binding."householdId")
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:binding_baby';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" AS operation
    LEFT JOIN "BrowserOperationBinding" AS binding ON binding."id" = operation."bindingId"
    WHERE binding."id" IS NULL
      OR binding."householdId" IS DISTINCT FROM operation."householdId"
      OR binding."operationId" IS DISTINCT FROM operation."operationId"
      OR binding."operationKey" IS DISTINCT FROM operation."operationKey"
      OR binding."actorUserId" IS DISTINCT FROM operation."actorUserId"
      OR binding."actorMemberId" IS DISTINCT FROM operation."actorMemberId"
      OR binding."intentFingerprint" IS DISTINCT FROM operation."intentFingerprint"
      OR binding."babyId" IS DISTINCT FROM operation."babyId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:operation_binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" AS operation
    LEFT JOIN "Household" AS household ON household."id" = operation."householdId"
    WHERE household."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:operation_household';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" AS operation
    LEFT JOIN "User" AS actor ON actor."id" = operation."actorUserId"
    WHERE actor."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:operation_actor_user';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" AS operation
    LEFT JOIN "HouseholdMember" AS member ON member."id" = operation."actorMemberId"
    WHERE member."id" IS NULL OR member."householdId" <> operation."householdId" OR member."userId" <> operation."actorUserId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:operation_member_actor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "BrowserMutationOperation" AS operation
    LEFT JOIN "Baby" AS baby ON baby."id" = operation."babyId"
    WHERE operation."babyId" IS NOT NULL AND (baby."id" IS NULL OR baby."householdId" <> operation."householdId")
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:operation_baby';
  END IF;

  -- source_reviewed_subset: this detects existing cross-household links but
  -- intentionally adds no CalendarEventBaby DDL or permanent relation claim.
  IF EXISTS (
    SELECT 1
    FROM "CalendarEventBaby" AS link
    JOIN "CalendarEvent" AS event ON event."id" = link."eventId"
    JOIN "Baby" AS baby ON baby."id" = link."babyId"
    WHERE event."householdId" <> baby."householdId"
  ) THEN
    RAISE EXCEPTION 'browser_operation_preflight_failed:calendar_event_baby';
  END IF;
END
$$;

CREATE UNIQUE INDEX "BrowserOperationBinding_householdId_operationId_key" ON "BrowserOperationBinding"("householdId", "operationId");
CREATE INDEX "BrowserOperationBinding_sessionId_idx" ON "BrowserOperationBinding"("sessionId");
CREATE INDEX "BrowserOperationBinding_householdId_actorMemberId_idx" ON "BrowserOperationBinding"("householdId", "actorMemberId");
CREATE INDEX "BrowserOperationBinding_householdId_babyId_idx" ON "BrowserOperationBinding"("householdId", "babyId");
CREATE INDEX "BrowserOperationBinding_state_expiresAt_idx" ON "BrowserOperationBinding"("state", "expiresAt");
CREATE UNIQUE INDEX "BrowserMutationOperation_bindingId_key" ON "BrowserMutationOperation"("bindingId");
CREATE INDEX "BrowserMutationOperation_householdId_actorMemberId_idx" ON "BrowserMutationOperation"("householdId", "actorMemberId");
CREATE INDEX "BrowserMutationOperation_householdId_babyId_idx" ON "BrowserMutationOperation"("householdId", "babyId");
CREATE INDEX "BrowserMutationOperation_status_createdAt_idx" ON "BrowserMutationOperation"("status", "createdAt");

-- Session identity is retained as data rather than a foreign key so normal session
-- revocation/deletion makes authorization stale without deleting operation history.
ALTER TABLE "BrowserOperationBinding"
  ADD CONSTRAINT "BrowserOperationBinding_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserOperationBinding"
  ADD CONSTRAINT "BrowserOperationBinding_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserOperationBinding"
  ADD CONSTRAINT "BrowserOperationBinding_householdId_actorMemberId_fkey"
  FOREIGN KEY ("householdId", "actorMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserOperationBinding"
  ADD CONSTRAINT "BrowserOperationBinding_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_bindingId_fkey"
  FOREIGN KEY ("bindingId") REFERENCES "BrowserOperationBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_householdId_actorMemberId_fkey"
  FOREIGN KEY ("householdId", "actorMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrowserMutationOperation"
  ADD CONSTRAINT "BrowserMutationOperation_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "prevent_terminal_browser_mutation_operation_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('completed', 'rejected', 'stale') THEN
    RAISE EXCEPTION 'terminal_browser_mutation_operation_immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BrowserMutationOperation_prevent_terminal_mutation"
BEFORE UPDATE OR DELETE ON "BrowserMutationOperation"
FOR EACH ROW
EXECUTE FUNCTION "prevent_terminal_browser_mutation_operation_mutation"();

-- source_reviewed_subset: CalendarEventBaby integrity remains source-enforced by
-- transaction-time locking/verification in the later calendar service slice. This
-- migration intentionally adds no CalendarEventBaby DDL or database-relation claim.
COMMIT;
