-- Durable server-issued registration operations bind a platform-owner actor,
-- normalized intent, and the settings revision observed at allocation.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "PlatformRegistrationOperationStatus" AS ENUM ('pending', 'completed', 'stale');

CREATE TABLE "PlatformRegistrationOperation" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorityId" TEXT NOT NULL DEFAULT 'platform',
    "intentFingerprint" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "householdCreationMode" "PlatformRegistrationMode" NOT NULL,
    "allowPublicRegistration" BOOLEAN NOT NULL,
    "status" "PlatformRegistrationOperationStatus" NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "auditEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformRegistrationOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformRegistrationOperation_actorUserId_id_idx"
  ON "PlatformRegistrationOperation"("actorUserId", "id");
CREATE INDEX "PlatformRegistrationOperation_createdAt_idx"
  ON "PlatformRegistrationOperation"("createdAt");
CREATE UNIQUE INDEX "PlatformRegistrationOperation_auditEventId_key"
  ON "PlatformRegistrationOperation"("auditEventId");

ALTER TABLE "PlatformRegistrationOperation"
  ADD CONSTRAINT "PlatformRegistrationOperation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformRegistrationOperation"
  ADD CONSTRAINT "PlatformRegistrationOperation_authorityId_fkey"
  FOREIGN KEY ("authorityId") REFERENCES "PlatformAuthority"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformRegistrationOperation"
  ADD CONSTRAINT "PlatformRegistrationOperation_auditEventId_fkey"
  FOREIGN KEY ("auditEventId") REFERENCES "PlatformAuditEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Once an outcome is durable, preserve every binding and replay result against
-- accidental application or maintenance-path mutation/deletion.
CREATE FUNCTION "prevent_terminal_platform_registration_operation_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('completed', 'stale') THEN
    RAISE EXCEPTION 'terminal_platform_registration_operation_immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformRegistrationOperation_prevent_terminal_mutation"
BEFORE UPDATE OR DELETE ON "PlatformRegistrationOperation"
FOR EACH ROW
EXECUTE FUNCTION "prevent_terminal_platform_registration_operation_mutation"();
