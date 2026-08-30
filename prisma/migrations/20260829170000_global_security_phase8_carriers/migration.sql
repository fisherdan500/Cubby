BEGIN;

-- Phase 8 class evidence is written at the state-transition owner.  These
-- definer triggers keep lifecycle evidence atomic without adding a reader or
-- broadening runtime table privileges.
CREATE OR REPLACE FUNCTION "guard_global_security_phase8_carrier_event"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE operation_row public."GlobalSecurityOperation"%ROWTYPE;
BEGIN
  IF NEW."eventType"='grant' AND NEW."outcome"='current_password_verified' THEN
    SELECT * INTO operation_row FROM public."GlobalSecurityOperation"
      WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
    IF NEW."operationId" IS NULL OR operation_row."operationKey" NOT IN ('password_change','recovery_enrollment','email_change','session_revoke')
      OR operation_row."status"<>'pending' THEN
      RAISE EXCEPTION 'global_security_phase8_grant_event_invalid';
    END IF;
  ELSIF NEW."eventType"='recovery' AND NEW."outcome" IN ('code_set_generated','rehearsed','rehearsal_failed','reset_started','reset_completed') AND NEW."operationId" IS NOT NULL THEN
    SELECT * INTO operation_row FROM public."GlobalSecurityOperation"
      WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
    IF operation_row."operationId" IS NULL OR operation_row."operationKey" NOT IN ('recovery_enrollment','recovery_reset') THEN
      RAISE EXCEPTION 'global_security_phase8_recovery_event_invalid';
    END IF;
  ELSIF NEW."eventType"='email_change' AND NEW."operationId" IS NULL THEN
    RAISE EXCEPTION 'global_security_phase8_email_event_invalid';
  ELSIF NEW."eventType"='session' AND NEW."outcome" IN ('revoked','already_revoked','stale_security_version') AND NEW."operationId" IS NULL THEN
    RAISE EXCEPTION 'global_security_phase8_session_event_invalid';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "01_GlobalSecurityEvent_phase8_carrier_guard" ON public."GlobalSecurityEvent";
CREATE TRIGGER "01_GlobalSecurityEvent_phase8_carrier_guard"
  BEFORE INSERT ON public."GlobalSecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION "guard_global_security_phase8_carrier_event"();

CREATE OR REPLACE FUNCTION "write_global_security_phase8_email_change_event"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_outcome TEXT;
BEGIN
  IF TG_OP='INSERT' THEN event_outcome:='requested';
  ELSIF NEW."state" IS NOT DISTINCT FROM OLD."state" THEN RETURN NEW;
  ELSIF NEW."state"='verified' THEN event_outcome:='verified';
  ELSIF NEW."state"='completed' THEN event_outcome:='completed';
  ELSIF NEW."state"='cancelled' THEN event_outcome:='cancelled';
  ELSIF NEW."state"='expired' THEN event_outcome:='expired';
  ELSIF NEW."state" IN ('abandoned','failed') THEN event_outcome:='failed';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt")
    VALUES ('gse_email_' || encode(gen_random_bytes(16),'hex'),NEW."userId",'email_change',event_outcome,NEW."operationId",NULL,'{}',clock_timestamp())
    ON CONFLICT ("userId","operationId","eventType","outcome") WHERE "operationId" IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "EmailChange_phase8_class_events" ON public."EmailChange";
CREATE TRIGGER "EmailChange_phase8_class_events"
  AFTER INSERT OR UPDATE OF "state" ON public."EmailChange"
  FOR EACH ROW EXECUTE FUNCTION "write_global_security_phase8_email_change_event"();

CREATE OR REPLACE FUNCTION "write_global_security_phase8_session_event"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_outcome TEXT;
BEGIN
  IF NEW."operationKey"='session_revoke' AND OLD."status"='pending' AND NEW."status"='completed' AND NEW."outcomeCode" IN ('revoked','already_revoked') THEN
    event_outcome:=NEW."outcomeCode";
  ELSIF NEW."operationKey"='session_revoke' AND OLD."status"='pending' AND NEW."status"='stale' AND NEW."outcomeCode"='stale_security_version' THEN
    event_outcome:='stale_security_version';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt")
    VALUES ('gse_session_' || encode(gen_random_bytes(16),'hex'),NEW."userId",'session',event_outcome,NEW."operationId",NULL,'{}',clock_timestamp())
    ON CONFLICT ("userId","operationId","eventType","outcome") WHERE "operationId" IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "GlobalSecurityOperation_phase8_session_events" ON public."GlobalSecurityOperation";
CREATE TRIGGER "GlobalSecurityOperation_phase8_session_events"
  AFTER UPDATE OF "status","outcomeCode" ON public."GlobalSecurityOperation"
  FOR EACH ROW EXECUTE FUNCTION "write_global_security_phase8_session_event"();

CREATE OR REPLACE FUNCTION "write_global_security_phase8_session_expired_event"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD."state"='active' AND NEW."state"='expired' THEN
    INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt")
      VALUES ('gse_session_' || encode(gen_random_bytes(16),'hex'),NEW."userId",'session','expired',NULL,NULL,'{}',clock_timestamp());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SessionSecurityActivity_phase8_expired_event" ON public."SessionSecurityActivity";
CREATE TRIGGER "SessionSecurityActivity_phase8_expired_event"
  AFTER UPDATE OF "state" ON public."SessionSecurityActivity"
  FOR EACH ROW EXECUTE FUNCTION "write_global_security_phase8_session_expired_event"();

REVOKE ALL ON FUNCTION "guard_global_security_phase8_carrier_event"(),"write_global_security_phase8_email_change_event"(),"write_global_security_phase8_session_event"(),"write_global_security_phase8_session_expired_event"() FROM PUBLIC;

COMMIT;
