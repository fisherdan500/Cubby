-- Household invitation email delivery (DEC-PROD-425). One encrypted delivery per invitation; the raw
-- invitation token exists only inside the AES-GCM ciphertext, which is cleared once a delivery can no
-- longer be sent. A replacement link is a new Invite row, so re-sending is a new delivery.
CREATE TABLE "InvitationEmailDelivery" ("id" TEXT NOT NULL,"householdId" TEXT NOT NULL,"inviteId" TEXT NOT NULL,"operationId" UUID NOT NULL,"recipientDigest" BYTEA NOT NULL,"state" "EmailChangeDeliveryState" NOT NULL DEFAULT 'queued',"ciphertext" BYTEA,"iv" BYTEA,"authTag" BYTEA,"aadDigest" BYTEA,"keyVersion" INTEGER,"attemptCount" INTEGER NOT NULL DEFAULT 0,"leaseOwner" TEXT,"leaseExpiresAt" TIMESTAMP(3),"nextAttemptAt" TIMESTAMP(3),"smtpResponseCode" INTEGER,"messageIdDigest" BYTEA,"acceptedAt" TIMESTAMP(3),"lastFailureCode" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "InvitationEmailDelivery_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "InvitationEmailDelivery_inviteId_key" ON "InvitationEmailDelivery"("inviteId");
CREATE INDEX "InvitationEmailDelivery_state_nextAttemptAt_idx" ON "InvitationEmailDelivery"("state","nextAttemptAt");
CREATE INDEX "InvitationEmailDelivery_householdId_idx" ON "InvitationEmailDelivery"("householdId");
CREATE INDEX "InvitationEmailDelivery_keyVersion_idx" ON "InvitationEmailDelivery"("keyVersion");
ALTER TABLE "InvitationEmailDelivery" ADD CONSTRAINT "InvitationEmailDelivery_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE;
ALTER TABLE "InvitationEmailDelivery" ADD CONSTRAINT "InvitationEmailDelivery_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE CASCADE;
ALTER TABLE "InvitationEmailDelivery" ADD CONSTRAINT "InvitationEmailDelivery_keyVersion_fkey" FOREIGN KEY ("keyVersion") REFERENCES "EmailDeliveryEncryptionKey"("keyVersion") ON DELETE RESTRICT;
ALTER TABLE "InvitationEmailDelivery" ADD CONSTRAINT "InvitationEmailDelivery_shape_check" CHECK ("id" ~ '^ied_[0-9a-f]{32}$' AND octet_length("recipientDigest")=32 AND "attemptCount" BETWEEN 0 AND 8 AND (("state" IN ('queued','dispatching','retryable_failed') AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND octet_length("iv")=12 AND "authTag" IS NOT NULL AND octet_length("authTag")=16 AND "aadDigest" IS NOT NULL AND octet_length("aadDigest")=32 AND "keyVersion" IS NOT NULL) OR ("state" IN ('accepted','permanent_failed') AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "aadDigest" IS NULL AND "keyVersion" IS NULL)));
ALTER TABLE "InvitationEmailDelivery" ADD CONSTRAINT "InvitationEmailDelivery_lease_receipt_check" CHECK (("state"='dispatching')=("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) AND (("state"='accepted' AND "smtpResponseCode"=250 AND octet_length("messageIdDigest")=32 AND "acceptedAt" IS NOT NULL AND "lastFailureCode" IS NULL) OR ("state"<>'accepted' AND "smtpResponseCode" IS NULL AND "messageIdDigest" IS NULL AND "acceptedAt" IS NULL)));

-- Rows leave only with their invitation or household (both cascade); otherwise identity is immutable
-- and state moves forward only.
CREATE FUNCTION "enforce_invitation_email_delivery_transition"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM public."Invite" WHERE "id"=OLD."inviteId") OR NOT EXISTS (SELECT 1 FROM public."Household" WHERE "id"=OLD."householdId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'invitation_email_delivery_immutable'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."householdId" IS DISTINCT FROM OLD."householdId" OR NEW."inviteId" IS DISTINCT FROM OLD."inviteId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."recipientDigest" IS DISTINCT FROM OLD."recipientDigest" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'invitation_email_delivery_identity_immutable'; END IF;
  IF OLD."state" IN ('accepted','permanent_failed') OR NOT ((OLD."state"='queued' AND NEW."state" IN ('dispatching','permanent_failed')) OR (OLD."state"='dispatching' AND NEW."state" IN ('accepted','retryable_failed','permanent_failed')) OR (OLD."state"='retryable_failed' AND NEW."state" IN ('dispatching','permanent_failed'))) THEN RAISE EXCEPTION 'invitation_email_delivery_invalid_transition'; END IF;
  IF NEW."state"='permanent_failed' AND NEW."lastFailureCode" NOT IN ('attempts_exhausted','payload_decrypt','receipt_invalid','recipient_rejected','smtp_auth','smtp_rejected','cancelled','expired') THEN RAISE EXCEPTION 'invitation_email_delivery_failure_code_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION "enforce_invitation_email_delivery_insert"() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE invite_row public."Invite"%ROWTYPE; BEGIN
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=NEW."inviteId" FOR UPDATE;
  IF invite_row."id" IS NULL OR invite_row."householdId"<>NEW."householdId" OR invite_row."status"<>'pending' OR invite_row."expiresAt"<=clock_timestamp() OR public.digest(convert_to(lower(btrim(invite_row."email")),'UTF8'),'sha256')<>NEW."recipientDigest" OR NEW."state"<>'queued' OR NEW."attemptCount"<>0 OR NOT EXISTS (SELECT 1 FROM public."EmailDeliveryEncryptionKey" WHERE "keyVersion"=NEW."keyVersion" AND "activeWrite"=true) THEN RAISE EXCEPTION 'invitation_email_delivery_insert_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "InvitationEmailDelivery_insert_guard" BEFORE INSERT ON "InvitationEmailDelivery" FOR EACH ROW EXECUTE FUNCTION "enforce_invitation_email_delivery_insert"();
CREATE TRIGGER "InvitationEmailDelivery_transition_guard" BEFORE UPDATE OR DELETE ON "InvitationEmailDelivery" FOR EACH ROW EXECUTE FUNCTION "enforce_invitation_email_delivery_transition"();

-- Revoking, replacing, accepting, expiring or conflicting an invitation ends any unsent delivery and
-- destroys its ciphertext. An in-flight send finishes, but its link no longer works.
CREATE FUNCTION "close_invitation_email_delivery_on_invite_change"() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  UPDATE public."InvitationEmailDelivery" SET "state"='permanent_failed',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"lastFailureCode"='cancelled',"updatedAt"=clock_timestamp() WHERE "inviteId"=NEW."id" AND "state" IN ('queued','retryable_failed');
  RETURN NULL;
END $$;
CREATE TRIGGER "Invite_email_delivery_close" AFTER UPDATE OF "status" ON "Invite" FOR EACH ROW WHEN (OLD."status"='pending' AND NEW."status"<>'pending') EXECUTE FUNCTION "close_invitation_email_delivery_on_invite_change"();

CREATE OR REPLACE FUNCTION "enforce_email_delivery_key_reference"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "EmailChangeDelivery" WHERE "keyVersion"=OLD."keyVersion" AND "state" IN ('queued','dispatching','retryable_failed')) OR EXISTS (SELECT 1 FROM "InvitationEmailDelivery" WHERE "keyVersion"=OLD."keyVersion" AND "state" IN ('queued','dispatching','retryable_failed')) THEN RAISE EXCEPTION 'email_delivery_key_still_referenced'; END IF; RETURN OLD; END $$;

-- The issuer queues an invitation email right after a completed create or replace. The caller must hold
-- the display-once token (the Invite is found by its hash) and re-present the same issuer carrier.
CREATE OR REPLACE FUNCTION invitation_protocol.enqueue_manual_invitation_email_v1(operation_id UUID, token_hash TEXT, delivery_id TEXT, recipient_digest BYTEA, ciphertext BYTEA, iv BYTEA, auth_tag BYTEA, aad_digest BYTEA, key_version INTEGER, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; invite_row public."Invite"%ROWTYPE;
BEGIN
  IF operation_id IS NULL OR token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$' OR delivery_id IS NULL OR delivery_id !~ '^ied_[0-9a-f]{32}$' OR octet_length(recipient_digest) IS DISTINCT FROM 32 THEN RAISE EXCEPTION 'invitation_email_enqueue_invalid'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind" IN ('MANUAL_INVITE_CREATE','MANUAL_INVITE_REPLACE') FOR UPDATE;
  IF NOT FOUND OR identity_row."state"<>'TERMINAL_FULL' THEN RAISE EXCEPTION 'invitation_email_enqueue_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id);
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,identity_row."operationKind",request_attestation);
  SELECT * INTO invite_row FROM public."Invite" WHERE "tokenHash"=token_hash AND "householdId"=identity_row."householdId" FOR UPDATE;
  IF NOT FOUND OR invite_row."status"<>'pending' OR invite_row."expiresAt"<=clock_timestamp() OR invite_row."role"='owner' OR invite_row."invitedByUserId" IS DISTINCT FROM (request_attestation).subject_user_id OR public.digest(convert_to(lower(btrim(invite_row."email")),'UTF8'),'sha256')<>recipient_digest THEN RAISE EXCEPTION 'invitation_email_enqueue_invalid'; END IF;
  PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,invite_row."role",false,'manual_invite_email');
  IF NOT EXISTS (SELECT 1 FROM public."EmailDeliveryEncryptionKey" WHERE "keyVersion"=key_version AND "activeWrite"=true) THEN RAISE EXCEPTION 'invitation_email_enqueue_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public."InvitationEmailDelivery" WHERE "inviteId"=invite_row."id") THEN RETURN jsonb_build_object('operationId',operation_id,'status','queued'); END IF;
  INSERT INTO public."InvitationEmailDelivery"("id","householdId","inviteId","operationId","recipientDigest","state","ciphertext","iv","authTag","aadDigest","keyVersion","attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES(delivery_id,identity_row."householdId",invite_row."id",operation_id,recipient_digest,'queued',ciphertext,iv,auth_tag,aad_digest,key_version,0,clock_timestamp(),clock_timestamp(),clock_timestamp());
  RETURN jsonb_build_object('operationId',operation_id,'status','queued');
END $$;

CREATE FUNCTION "claim_invitation_email_delivery"(worker_token TEXT) RETURNS SETOF "InvitationEmailDelivery" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF worker_token !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION 'email_delivery_worker_invalid'; END IF;
  UPDATE public."InvitationEmailDelivery" SET "state"=CASE WHEN "attemptCount">=8 THEN 'permanent_failed'::public."EmailChangeDeliveryState" ELSE 'retryable_failed'::public."EmailChangeDeliveryState" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN "attemptCount">=8 THEN NULL ELSE public."email_change_delivery_retry_at"("attemptCount") END,"lastFailureCode"=CASE WHEN "attemptCount">=8 THEN 'attempts_exhausted' ELSE 'smtp_timeout' END,"ciphertext"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "ciphertext" END,"iv"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "iv" END,"authTag"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "authTag" END,"aadDigest"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "aadDigest" END,"keyVersion"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "keyVersion" END,"updatedAt"=clock_timestamp() WHERE "state"='dispatching' AND "leaseExpiresAt"<=clock_timestamp();
  UPDATE public."InvitationEmailDelivery" delivery SET "state"='permanent_failed',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"nextAttemptAt"=NULL,"lastFailureCode"=CASE WHEN invite."status"<>'pending' THEN 'cancelled' ELSE 'expired' END,"updatedAt"=clock_timestamp() FROM public."Invite" invite WHERE invite."id"=delivery."inviteId" AND delivery."state" IN ('queued','retryable_failed') AND (invite."status"<>'pending' OR invite."expiresAt"<=clock_timestamp());
  RETURN QUERY WITH candidate AS (SELECT delivery."id" FROM public."InvitationEmailDelivery" delivery JOIN public."Invite" invite ON invite."id"=delivery."inviteId" WHERE delivery."state" IN ('queued','retryable_failed') AND (delivery."nextAttemptAt" IS NULL OR delivery."nextAttemptAt"<=clock_timestamp()) AND delivery."attemptCount"<8 AND invite."status"='pending' AND invite."expiresAt">clock_timestamp() ORDER BY delivery."nextAttemptAt" NULLS FIRST,delivery."createdAt" FOR UPDATE OF delivery SKIP LOCKED LIMIT 1) UPDATE public."InvitationEmailDelivery" delivery SET "state"='dispatching',"leaseOwner"=worker_token,"leaseExpiresAt"=clock_timestamp()+INTERVAL '5 minutes',"attemptCount"=delivery."attemptCount"+1,"updatedAt"=clock_timestamp() FROM candidate WHERE delivery."id"=candidate."id" RETURNING delivery.*;
END $$;
CREATE FUNCTION "accept_invitation_email_delivery"(delivery_id TEXT,worker_token TEXT,response_code INTEGER,message_digest BYTEA) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN UPDATE public."InvitationEmailDelivery" SET "state"='accepted',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"smtpResponseCode"=response_code,"messageIdDigest"=message_digest,"acceptedAt"=clock_timestamp(),"lastFailureCode"=NULL,"updatedAt"=clock_timestamp() WHERE "id"=delivery_id AND "state"='dispatching' AND "leaseOwner"=worker_token AND "leaseExpiresAt">clock_timestamp() AND response_code=250 AND octet_length(message_digest)=32; IF NOT FOUND THEN RAISE EXCEPTION 'email_delivery_lease_lost'; END IF; END $$;
CREATE FUNCTION "fail_invitation_email_delivery"(delivery_id TEXT,worker_token TEXT,failure_code TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE retryable BOOLEAN; exhausted BOOLEAN; BEGIN retryable:=failure_code IN ('smtp_connection','smtp_rate_limited','smtp_temporary','smtp_timeout'); IF NOT retryable AND failure_code NOT IN ('payload_decrypt','receipt_invalid','recipient_rejected','smtp_auth','smtp_rejected') THEN RAISE EXCEPTION 'email_delivery_failure_code_invalid'; END IF; SELECT "attemptCount">=8 INTO exhausted FROM public."InvitationEmailDelivery" WHERE "id"=delivery_id AND "state"='dispatching' AND "leaseOwner"=worker_token FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'email_delivery_lease_lost'; END IF; UPDATE public."InvitationEmailDelivery" SET "state"=CASE WHEN retryable AND NOT exhausted THEN 'retryable_failed'::public."EmailChangeDeliveryState" ELSE 'permanent_failed'::public."EmailChangeDeliveryState" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN retryable AND NOT exhausted THEN public."email_change_delivery_retry_at"("attemptCount") ELSE NULL END,"lastFailureCode"=CASE WHEN retryable AND exhausted THEN 'attempts_exhausted' ELSE failure_code END,"ciphertext"=CASE WHEN retryable AND NOT exhausted THEN "ciphertext" ELSE NULL END,"iv"=CASE WHEN retryable AND NOT exhausted THEN "iv" ELSE NULL END,"authTag"=CASE WHEN retryable AND NOT exhausted THEN "authTag" ELSE NULL END,"aadDigest"=CASE WHEN retryable AND NOT exhausted THEN "aadDigest" ELSE NULL END,"keyVersion"=CASE WHEN retryable AND NOT exhausted THEN "keyVersion" ELSE NULL END,"updatedAt"=clock_timestamp() WHERE "id"=delivery_id; END $$;

REVOKE ALL ON TABLE "InvitationEmailDelivery" FROM PUBLIC;
REVOKE ALL ON FUNCTION "claim_invitation_email_delivery"(TEXT),"accept_invitation_email_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_invitation_email_delivery"(TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION invitation_protocol.enqueue_manual_invitation_email_v1(UUID,TEXT,TEXT,BYTEA,BYTEA,BYTEA,BYTEA,BYTEA,INTEGER,invitation_protocol.invitation_request_attestation) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE ALL ON TABLE "InvitationEmailDelivery" FROM cubby_runtime;
    -- The pending list shows whether an invitation was emailed (column privileges cover its filter
    -- columns too); nothing encrypted is readable.
    GRANT SELECT ("id","householdId","inviteId","state") ON TABLE "InvitationEmailDelivery" TO cubby_runtime;
    REVOKE ALL ON FUNCTION "claim_invitation_email_delivery"(TEXT),"accept_invitation_email_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_invitation_email_delivery"(TEXT,TEXT,TEXT) FROM cubby_runtime;
    REVOKE ALL ON FUNCTION invitation_protocol.enqueue_manual_invitation_email_v1(UUID,TEXT,TEXT,BYTEA,BYTEA,BYTEA,BYTEA,BYTEA,INTEGER,invitation_protocol.invitation_request_attestation) FROM cubby_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_email_delivery') THEN
    REVOKE ALL ON TABLE "InvitationEmailDelivery" FROM cubby_email_delivery;
    GRANT EXECUTE ON FUNCTION "claim_invitation_email_delivery"(TEXT),"accept_invitation_email_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_invitation_email_delivery"(TEXT,TEXT,TEXT) TO cubby_email_delivery;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_invitation_runtime') THEN
    REVOKE ALL ON TABLE "InvitationEmailDelivery" FROM cubby_invitation_runtime;
    GRANT EXECUTE ON FUNCTION invitation_protocol.enqueue_manual_invitation_email_v1(UUID,TEXT,TEXT,BYTEA,BYTEA,BYTEA,BYTEA,BYTEA,INTEGER,invitation_protocol.invitation_request_attestation) TO cubby_invitation_runtime;
  END IF;
END $$;
