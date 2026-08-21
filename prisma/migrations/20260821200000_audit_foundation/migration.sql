BEGIN;

ALTER TABLE "AuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "actorUserSnapshot" TEXT,
  ADD COLUMN "actorMemberSnapshot" TEXT;

ALTER TABLE "PlatformAuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "actorUserSnapshot" TEXT;

CREATE FUNCTION "allow_household_audit_purge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('cubby.audit_household_purge', OLD.id, true);
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
     AND current_setting('cubby.audit_household_purge', true) = OLD."householdId" THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event_append_only';
END;
$$;

CREATE TRIGGER "Household_audit_purge_context"
BEFORE DELETE ON "Household"
FOR EACH ROW EXECUTE FUNCTION "allow_household_audit_purge"();

CREATE TRIGGER "AuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();

CREATE TRIGGER "PlatformAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();

COMMIT;
