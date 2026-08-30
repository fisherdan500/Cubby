BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "GlobalSecurityOperationKey" AS ENUM ('password_change', 'recovery_enrollment', 'recovery_reset', 'email_change', 'session_revoke');

-- CreateEnum
CREATE TYPE "GlobalSecurityOperationStatus" AS ENUM ('pending', 'unknown', 'completed', 'rejected', 'stale');

-- CreateEnum
CREATE TYPE "FreshAuthGrantState" AS ENUM ('issued', 'consumed', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "RecoveryCodeState" AS ENUM ('active', 'consumed', 'invalidated');

CREATE TYPE "RecoveryCodeSetState" AS ENUM ('generated', 'save_acknowledged', 'rehearsal_required', 'rehearsed', 'invalidated');
CREATE TYPE "RecoveryCodeConsumptionPurpose" AS ENUM ('enrollment_rehearsal', 'recovery_reset');

-- CreateEnum
CREATE TYPE "RecoverySessionState" AS ENUM ('restricted', 'consumed', 'closed', 'expired');

-- CreateEnum
CREATE TYPE "EmailChangeState" AS ENUM ('pending', 'verified', 'cancelled', 'expired', 'abandoned', 'failed', 'completed');
CREATE TYPE "EmailChangeDeliveryKind" AS ENUM ('new_verification','new_cutover','old_request','old_cutover','inviter_notice','invitation_reissue');
CREATE TYPE "EmailChangeDeliveryState" AS ENUM ('queued','dispatching','accepted','retryable_failed','permanent_failed');
CREATE TYPE "EmailChangeCookieState" AS ENUM ('issued','confirmed','failed');

-- CreateEnum
CREATE TYPE "GlobalSecurityIncidentState" AS ENUM ('active', 'quiet', 'closed');

-- CreateEnum
CREATE TYPE "SessionSecurityActivityState" AS ENUM ('active', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "AccountSecurityState" (
    "userId" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "sessionSecurityVersion" INTEGER NOT NULL DEFAULT 1,
    "lastCredentialOperationId" TEXT,
    "lastSessionSecurityOperationId" TEXT,
    "securityUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSecurityState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "FreshAuthGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "attestationNonce" TEXT,
    "attestationMac" BYTEA,
    "attestationKeyVersion" INTEGER,
    "replacementPasswordHashDigest" BYTEA,
    "state" "FreshAuthGrantState" NOT NULL DEFAULT 'issued',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreshAuthGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FreshAuthAttestationKey" (
    "keyVersion" INTEGER NOT NULL,
    "verificationKey" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    CONSTRAINT "FreshAuthAttestationKey_pkey" PRIMARY KEY ("keyVersion"),
    CONSTRAINT "FreshAuthAttestationKey_key_length_check" CHECK (octet_length("verificationKey") = 32)
);
CREATE UNIQUE INDEX "FreshAuthGrant_attestationNonce_key" ON "FreshAuthGrant"("attestationNonce");

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "setVersion" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "salt" BYTEA NOT NULL,
    "derivedKey" BYTEA NOT NULL,
    "kdfVersion" INTEGER NOT NULL DEFAULT 1,
    "state" "RecoveryCodeState" NOT NULL DEFAULT 'active',
    "consumedPurpose" "RecoveryCodeConsumptionPurpose",
    "consumedOperationId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryCodeSet" (
    "userId" TEXT NOT NULL,
    "setVersion" INTEGER NOT NULL,
    "issuanceOperationId" TEXT NOT NULL,
    "freshAuthGrantId" TEXT NOT NULL,
    "issuanceSecurityVersion" INTEGER NOT NULL,
    "issuanceSessionSecurityVersion" INTEGER NOT NULL,
    "expectedCodeCount" INTEGER NOT NULL DEFAULT 10,
    "state" "RecoveryCodeSetState" NOT NULL DEFAULT 'generated',
    "saveAcknowledgedAt" TIMESTAMP(3),
    "rehearsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryCodeSet_pkey" PRIMARY KEY ("userId","setVersion")
);

-- CreateTable
CREATE TABLE "RecoverySession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recoveryCodeId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'recovery_reset',
    "attestationNonce" TEXT,
    "attestationMac" BYTEA,
    "attestationKeyVersion" INTEGER,
    "replacementPasswordHashDigest" BYTEA,
    "attestedOpeningFingerprint" TEXT,
    "attestedIntentFingerprint" TEXT,
    "state" "RecoverySessionState" NOT NULL DEFAULT 'restricted',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoverySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalSecurityOperationBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "recoverySessionId" TEXT,
    "operationId" TEXT NOT NULL,
    "operationKey" "GlobalSecurityOperationKey" NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "sessionSecurityVersion" INTEGER NOT NULL DEFAULT 1,
    "openingFingerprint" TEXT NOT NULL,
    "targetSnapshot" JSONB NOT NULL,
    "state" "BrowserOperationBindingState" NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalSecurityOperationBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalSecurityOperation" (
    "bindingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationKey" "GlobalSecurityOperationKey" NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "status" "GlobalSecurityOperationStatus" NOT NULL DEFAULT 'pending',
    "outcomeVersion" INTEGER,
    "outcomeCode" TEXT,
    "outcomeSnapshot" JSONB,
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalSecurityOperation_pkey" PRIMARY KEY ("userId","operationId")
);

-- CreateTable
CREATE TABLE "GlobalSecurityOperationTombstone" (
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationKey" "GlobalSecurityOperationKey" NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "terminalStatus" "GlobalSecurityOperationStatus" NOT NULL,
    "terminalCode" TEXT NOT NULL,
    "terminalAt" TIMESTAMP(3) NOT NULL,
    "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalSecurityOperationTombstone_pkey" PRIMARY KEY ("userId","operationId")
);

-- CreateTable
CREATE TABLE "GlobalSecurityOperationReservationTombstone" (
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationKey" "GlobalSecurityOperationKey" NOT NULL,
    "sessionId" TEXT,
    "recoverySessionId" TEXT,
    "openingFingerprint" TEXT NOT NULL,
    "terminalCode" TEXT NOT NULL,
    "terminalAt" TIMESTAMP(3) NOT NULL,
    "compactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalSecurityOperationReservationTombstone_pkey" PRIMARY KEY ("userId","operationId")
);


-- CreateTable
CREATE TABLE "GlobalSecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "operationId" TEXT,
    "safeProjection" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalSecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GlobalSecurityEvent_one_operation_outcome" ON "GlobalSecurityEvent"("userId","operationId","eventType") WHERE "eventType"='operation_outcome';

-- CreateTable
CREATE TABLE "GlobalSecurityIncident" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "layer" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "quietUntil" TIMESTAMP(3),
    "state" "GlobalSecurityIncidentState" NOT NULL DEFAULT 'active',
    "lastOutcomeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalSecurityIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "freshAuthGrantId" TEXT NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "sessionSecurityVersion" INTEGER NOT NULL DEFAULT 1,
    "normalizedNewEmail" TEXT NOT NULL,
    "verificationDigest" TEXT NOT NULL,
    "state" "EmailChangeState" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailDeliveryEncryptionKey" ("keyVersion" INTEGER NOT NULL,"keyDigest" BYTEA NOT NULL,"activeWrite" BOOLEAN NOT NULL DEFAULT false,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"retiredAt" TIMESTAMP(3),CONSTRAINT "EmailDeliveryEncryptionKey_pkey" PRIMARY KEY ("keyVersion"));
CREATE UNIQUE INDEX "EmailDeliveryEncryptionKey_one_active_write" ON "EmailDeliveryEncryptionKey"(("activeWrite")) WHERE "activeWrite"=true;
CREATE TABLE "EmailChangeDelivery" ("id" TEXT NOT NULL,"userId" TEXT NOT NULL,"emailChangeId" TEXT NOT NULL,"operationId" TEXT NOT NULL,"kind" "EmailChangeDeliveryKind" NOT NULL,"recipientDigest" BYTEA NOT NULL,"state" "EmailChangeDeliveryState" NOT NULL DEFAULT 'queued',"ciphertext" BYTEA,"iv" BYTEA,"authTag" BYTEA,"aadDigest" BYTEA,"keyVersion" INTEGER,"attemptCount" INTEGER NOT NULL DEFAULT 0,"leaseOwner" TEXT,"leaseExpiresAt" TIMESTAMP(3),"nextAttemptAt" TIMESTAMP(3),"smtpResponseCode" INTEGER,"messageIdDigest" BYTEA,"acceptedAt" TIMESTAMP(3),"lastFailureCode" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "EmailChangeDelivery_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "EmailChangeDelivery_identity_key" ON "EmailChangeDelivery"("emailChangeId","kind","recipientDigest");
CREATE UNIQUE INDEX "EmailChange_userId_id_key" ON "EmailChange"("userId","id");
CREATE UNIQUE INDEX "EmailChange_userId_id_operationId_key" ON "EmailChange"("userId","id","operationId");
CREATE INDEX "EmailChangeDelivery_state_nextAttemptAt_idx" ON "EmailChangeDelivery"("state","nextAttemptAt");
CREATE INDEX "EmailChangeDelivery_userId_operationId_idx" ON "EmailChangeDelivery"("userId","operationId");
CREATE INDEX "EmailChangeDelivery_keyVersion_idx" ON "EmailChangeDelivery"("keyVersion");
CREATE TABLE "EmailChangeIdentityMutation" ("userId" TEXT NOT NULL,"operationId" TEXT NOT NULL,"oldEmailDigest" BYTEA NOT NULL,"newEmailDigest" BYTEA NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "EmailChangeIdentityMutation_pkey" PRIMARY KEY ("userId","operationId"));
CREATE TABLE "EmailChangeSessionRotation" ("userId" TEXT NOT NULL,"operationId" TEXT NOT NULL,"oldSessionId" TEXT NOT NULL,"successorSessionId" TEXT NOT NULL,"successorTokenDigest" BYTEA NOT NULL,"activityOriginalCreatedAt" TIMESTAMP(3) NOT NULL,"cookieState" "EmailChangeCookieState" NOT NULL DEFAULT 'issued',"issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"confirmedAt" TIMESTAMP(3),"failedAt" TIMESTAMP(3),CONSTRAINT "EmailChangeSessionRotation_pkey" PRIMARY KEY ("userId","operationId"));
CREATE UNIQUE INDEX "EmailChangeSessionRotation_successorSessionId_key" ON "EmailChangeSessionRotation"("successorSessionId");
CREATE INDEX "EmailChangeSessionRotation_cookieState_issuedAt_idx" ON "EmailChangeSessionRotation"("cookieState","issuedAt");
CREATE FUNCTION "normalize_security_email_v1"(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT lower(btrim(value)) COLLATE "C" $$;
CREATE UNIQUE INDEX "User_email_normalized_unique" ON "User"("normalize_security_email_v1"("email"));
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_userId_emailChangeId_operationId_fkey" FOREIGN KEY ("userId","emailChangeId","operationId") REFERENCES "EmailChange"("userId","id","operationId") ON DELETE CASCADE;
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_userId_operationId_fkey" FOREIGN KEY ("userId","operationId") REFERENCES "GlobalSecurityOperation"("userId","operationId") ON DELETE CASCADE;
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_keyVersion_fkey" FOREIGN KEY ("keyVersion") REFERENCES "EmailDeliveryEncryptionKey"("keyVersion") ON DELETE RESTRICT;
ALTER TABLE "EmailChangeIdentityMutation" ADD CONSTRAINT "EmailChangeIdentityMutation_userId_operationId_fkey" FOREIGN KEY ("userId","operationId") REFERENCES "GlobalSecurityOperation"("userId","operationId") ON DELETE CASCADE;
ALTER TABLE "EmailChangeSessionRotation" ADD CONSTRAINT "EmailChangeSessionRotation_userId_operationId_fkey" FOREIGN KEY ("userId","operationId") REFERENCES "GlobalSecurityOperation"("userId","operationId") ON DELETE CASCADE;

ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_shape_check" CHECK (octet_length("recipientDigest")=32 AND "attemptCount" BETWEEN 0 AND 8 AND (("state" IN ('queued','dispatching','retryable_failed') AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND octet_length("iv")=12 AND "authTag" IS NOT NULL AND octet_length("authTag")=16 AND "aadDigest" IS NOT NULL AND octet_length("aadDigest")=32 AND "keyVersion" IS NOT NULL) OR ("state" IN ('accepted','permanent_failed') AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "aadDigest" IS NULL AND "keyVersion" IS NULL)));

CREATE FUNCTION "enforce_email_change_delivery_transition"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'email_change_delivery_immutable'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."emailChangeId" IS DISTINCT FROM OLD."emailChangeId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."recipientDigest" IS DISTINCT FROM OLD."recipientDigest" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'email_change_delivery_identity_immutable'; END IF;
  IF OLD."state" IN ('accepted','permanent_failed') OR NOT ((OLD."state"='queued' AND NEW."state"='dispatching') OR (OLD."state"='dispatching' AND NEW."state" IN ('accepted','retryable_failed','permanent_failed')) OR (OLD."state"='retryable_failed' AND NEW."state" IN ('dispatching','permanent_failed'))) THEN RAISE EXCEPTION 'email_change_delivery_invalid_transition'; END IF;
  IF NEW."state"='accepted' AND (NEW."smtpResponseCode"<>250 OR NEW."messageIdDigest" IS NULL OR octet_length(NEW."messageIdDigest")<>32 OR NEW."acceptedAt" IS NULL) THEN RAISE EXCEPTION 'email_change_delivery_receipt_required'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION "enforce_email_change_delivery_insert"() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE change_row "EmailChange"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; BEGIN SELECT * INTO change_row FROM "EmailChange" WHERE "userId"=NEW."userId" AND "id"=NEW."emailChangeId" AND "operationId"=NEW."operationId" FOR UPDATE; SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE; IF change_row."id" IS NULL OR change_row."state" NOT IN ('pending','verified','completed') OR operation_row."operationKey"<>'email_change' OR operation_row."status" NOT IN ('pending','unknown','completed') OR NEW."state"<>'queued' OR NEW."attemptCount"<>0 OR NOT EXISTS (SELECT 1 FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=NEW."keyVersion" AND "activeWrite"=true) THEN RAISE EXCEPTION 'email_change_delivery_insert_invalid'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "EmailChangeDelivery_insert_guard" BEFORE INSERT ON "EmailChangeDelivery" FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_delivery_insert"();
CREATE TRIGGER "EmailChangeDelivery_transition_guard" BEFORE UPDATE OR DELETE ON "EmailChangeDelivery" FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_delivery_transition"();
CREATE FUNCTION "enforce_email_delivery_key_reference"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "EmailChangeDelivery" WHERE "keyVersion"=OLD."keyVersion" AND "state" IN ('queued','dispatching','retryable_failed')) THEN RAISE EXCEPTION 'email_delivery_key_still_referenced'; END IF; RETURN OLD; END $$;
CREATE TRIGGER "EmailDeliveryEncryptionKey_ciphertext_reference_guard" BEFORE DELETE ON "EmailDeliveryEncryptionKey" FOR EACH ROW EXECUTE FUNCTION "enforce_email_delivery_key_reference"();
ALTER TABLE "EmailDeliveryEncryptionKey" ADD CONSTRAINT "EmailDeliveryEncryptionKey_digest_check" CHECK (octet_length("keyDigest")=32);
ALTER TABLE "EmailChangeIdentityMutation" ADD CONSTRAINT "EmailChangeIdentityMutation_digest_check" CHECK (octet_length("oldEmailDigest")=32 AND octet_length("newEmailDigest")=32);
ALTER TABLE "EmailChangeSessionRotation" ADD CONSTRAINT "EmailChangeSessionRotation_shape_check" CHECK (octet_length("successorTokenDigest")=32 AND (("cookieState"='issued' AND "confirmedAt" IS NULL AND "failedAt" IS NULL) OR ("cookieState"='confirmed' AND "confirmedAt" IS NOT NULL AND "failedAt" IS NULL) OR ("cookieState"='failed' AND "confirmedAt" IS NULL AND "failedAt" IS NOT NULL)));
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_lease_receipt_check" CHECK (("state"='dispatching')=("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) AND (("state"='accepted' AND "smtpResponseCode"=250 AND octet_length("messageIdDigest")=32 AND "acceptedAt" IS NOT NULL AND "lastFailureCode" IS NULL) OR ("state"<>'accepted' AND "smtpResponseCode" IS NULL AND "messageIdDigest" IS NULL AND "acceptedAt" IS NULL)));
CREATE FUNCTION "enforce_email_delivery_exactly_one_active_key"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM "EmailDeliveryEncryptionKey" WHERE "activeWrite"=true)<>1 THEN RAISE EXCEPTION 'email_delivery_exactly_one_active_key_required'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER "EmailDeliveryEncryptionKey_exactly_one_active_guard" AFTER INSERT OR UPDATE OR DELETE ON "EmailDeliveryEncryptionKey" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_email_delivery_exactly_one_active_key"();
CREATE FUNCTION "prevent_email_change_identity_mutation_change"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'email_change_identity_mutation_immutable'; END $$;
CREATE TRIGGER "EmailChangeIdentityMutation_immutable" BEFORE UPDATE OR DELETE ON "EmailChangeIdentityMutation" FOR EACH ROW EXECUTE FUNCTION "prevent_email_change_identity_mutation_change"();
CREATE FUNCTION "enforce_email_change_session_rotation"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'email_change_session_rotation_immutable'; END IF; IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."oldSessionId" IS DISTINCT FROM OLD."oldSessionId" OR NEW."successorSessionId" IS DISTINCT FROM OLD."successorSessionId" OR NEW."successorTokenDigest" IS DISTINCT FROM OLD."successorTokenDigest" OR NEW."activityOriginalCreatedAt" IS DISTINCT FROM OLD."activityOriginalCreatedAt" OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" THEN RAISE EXCEPTION 'email_change_session_rotation_identity_immutable'; END IF; IF NOT (OLD."cookieState"='issued' AND NEW."cookieState" IN ('confirmed','failed')) THEN RAISE EXCEPTION 'email_change_session_rotation_invalid_transition'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "EmailChangeSessionRotation_state_guard" BEFORE UPDATE OR DELETE ON "EmailChangeSessionRotation" FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_session_rotation"();
CREATE FUNCTION "email_change_delivery_retry_at"(attempts INTEGER) RETURNS TIMESTAMP(3) LANGUAGE sql STABLE AS $$
  SELECT clock_timestamp() + (ARRAY['1 minute'::interval,'5 minutes'::interval,'15 minutes'::interval,'60 minutes'::interval,'240 minutes'::interval,'720 minutes'::interval,'1440 minutes'::interval])[GREATEST(1,LEAST(attempts,7))]
$$;
CREATE FUNCTION "claim_email_change_delivery"(worker_token TEXT) RETURNS SETOF "EmailChangeDelivery" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF worker_token !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION 'email_delivery_worker_invalid'; END IF;
  UPDATE public."EmailChangeDelivery" SET "state"=CASE WHEN "attemptCount">=8 THEN 'permanent_failed'::public."EmailChangeDeliveryState" ELSE 'retryable_failed'::public."EmailChangeDeliveryState" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN "attemptCount">=8 THEN NULL ELSE public."email_change_delivery_retry_at"("attemptCount") END,"lastFailureCode"=CASE WHEN "attemptCount">=8 THEN 'attempts_exhausted' ELSE 'smtp_timeout' END,"ciphertext"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "ciphertext" END,"iv"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "iv" END,"authTag"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "authTag" END,"aadDigest"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "aadDigest" END,"keyVersion"=CASE WHEN "attemptCount">=8 THEN NULL ELSE "keyVersion" END,"updatedAt"=clock_timestamp() WHERE "state"='dispatching' AND "leaseExpiresAt"<=clock_timestamp();
  RETURN QUERY WITH candidate AS (SELECT "id" FROM public."EmailChangeDelivery" WHERE "state" IN ('queued','retryable_failed') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=clock_timestamp()) AND "attemptCount"<8 ORDER BY "nextAttemptAt" NULLS FIRST,"createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE public."EmailChangeDelivery" delivery SET "state"='dispatching',"leaseOwner"=worker_token,"leaseExpiresAt"=clock_timestamp()+INTERVAL '5 minutes',"attemptCount"=delivery."attemptCount"+1,"updatedAt"=clock_timestamp() FROM candidate WHERE delivery."id"=candidate."id" RETURNING delivery.*;
END $$;
CREATE FUNCTION "accept_email_change_delivery"(delivery_id TEXT,worker_token TEXT,response_code INTEGER,message_digest BYTEA) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN UPDATE public."EmailChangeDelivery" SET "state"='accepted',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"smtpResponseCode"=response_code,"messageIdDigest"=message_digest,"acceptedAt"=clock_timestamp(),"lastFailureCode"=NULL,"updatedAt"=clock_timestamp() WHERE "id"=delivery_id AND "state"='dispatching' AND "leaseOwner"=worker_token AND "leaseExpiresAt">clock_timestamp() AND response_code=250 AND octet_length(message_digest)=32; IF NOT FOUND THEN RAISE EXCEPTION 'email_delivery_lease_lost'; END IF; END $$;
CREATE FUNCTION "fail_email_change_delivery"(delivery_id TEXT,worker_token TEXT,failure_code TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE retryable BOOLEAN; exhausted BOOLEAN; BEGIN retryable:=failure_code IN ('smtp_connection','smtp_rate_limited','smtp_temporary','smtp_timeout'); IF NOT retryable AND failure_code NOT IN ('payload_decrypt','receipt_invalid','recipient_rejected','smtp_auth','smtp_rejected') THEN RAISE EXCEPTION 'email_delivery_failure_code_invalid'; END IF; SELECT "attemptCount">=8 INTO exhausted FROM public."EmailChangeDelivery" WHERE "id"=delivery_id AND "state"='dispatching' AND "leaseOwner"=worker_token FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'email_delivery_lease_lost'; END IF; UPDATE public."EmailChangeDelivery" SET "state"=CASE WHEN retryable AND NOT exhausted THEN 'retryable_failed'::public."EmailChangeDeliveryState" ELSE 'permanent_failed'::public."EmailChangeDeliveryState" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN retryable AND NOT exhausted THEN public."email_change_delivery_retry_at"("attemptCount") ELSE NULL END,"lastFailureCode"=CASE WHEN retryable AND exhausted THEN 'attempts_exhausted' ELSE failure_code END,"ciphertext"=CASE WHEN retryable AND NOT exhausted THEN "ciphertext" ELSE NULL END,"iv"=CASE WHEN retryable AND NOT exhausted THEN "iv" ELSE NULL END,"authTag"=CASE WHEN retryable AND NOT exhausted THEN "authTag" ELSE NULL END,"aadDigest"=CASE WHEN retryable AND NOT exhausted THEN "aadDigest" ELSE NULL END,"keyVersion"=CASE WHEN retryable AND NOT exhausted THEN "keyVersion" ELSE NULL END,"updatedAt"=clock_timestamp() WHERE "id"=delivery_id; END $$;
REVOKE ALL ON FUNCTION "claim_email_change_delivery"(TEXT),"accept_email_change_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_email_change_delivery"(TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE ALL ON FUNCTION "claim_email_change_delivery"(TEXT),"accept_email_change_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_email_change_delivery"(TEXT,TEXT,TEXT) FROM cubby_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_email_delivery') THEN
    REVOKE ALL ON FUNCTION "claim_email_change_delivery"(TEXT),"accept_email_change_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_email_change_delivery"(TEXT,TEXT,TEXT) FROM cubby_email_delivery;
    GRANT EXECUTE ON FUNCTION "claim_email_change_delivery"(TEXT),"accept_email_change_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_email_change_delivery"(TEXT,TEXT,TEXT) TO cubby_email_delivery;
  END IF;
END $$;

-- CreateTable
CREATE TABLE "SessionSecurityActivity" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuanceSessionSecurityVersion" INTEGER NOT NULL,
    "originalCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastQualifyingAt" TIMESTAMP(3) NOT NULL,
    "warningAt" TIMESTAMP(3),
    "state" "SessionSecurityActivityState" NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionSecurityActivity_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE INDEX "FreshAuthGrant_userId_purpose_state_idx" ON "FreshAuthGrant"("userId", "purpose", "state");

-- CreateIndex
CREATE INDEX "FreshAuthGrant_sessionId_idx" ON "FreshAuthGrant"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "FreshAuthGrant_userId_operationId_key" ON "FreshAuthGrant"("userId", "operationId");
CREATE UNIQUE INDEX "Account_one_credential_per_user" ON "Account"("userId") WHERE "providerId" = 'credential';
-- CreateTable
CREATE TABLE "PasswordChangeCredentialMutation" (
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordChangeCredentialMutation_pkey" PRIMARY KEY ("userId", "operationId")
);
ALTER TABLE "PasswordChangeCredentialMutation" ADD CONSTRAINT "PasswordChangeCredentialMutation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordChangeCredentialMutation" ADD CONSTRAINT "PasswordChangeCredentialMutation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PasswordChangeCredentialMutation" ADD CONSTRAINT "PasswordChangeCredentialMutation_userId_operationId_fkey" FOREIGN KEY ("userId", "operationId") REFERENCES "GlobalSecurityOperation"("userId", "operationId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PasswordChangeCredentialMutation_accountId_idx" ON "PasswordChangeCredentialMutation"("accountId");
CREATE TABLE "RecoveryResetCredentialMutation" (
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecoveryResetCredentialMutation_pkey" PRIMARY KEY ("userId", "operationId")
);
ALTER TABLE "RecoveryResetCredentialMutation" ADD CONSTRAINT "RecoveryResetCredentialMutation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryResetCredentialMutation" ADD CONSTRAINT "RecoveryResetCredentialMutation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryResetCredentialMutation" ADD CONSTRAINT "RecoveryResetCredentialMutation_userId_operationId_fkey" FOREIGN KEY ("userId", "operationId") REFERENCES "GlobalSecurityOperation"("userId", "operationId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "RecoveryResetCredentialMutation_accountId_idx" ON "RecoveryResetCredentialMutation"("accountId");
ALTER TABLE "FreshAuthGrant" ADD CONSTRAINT "FreshAuthGrant_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "RecoveryCodeSet" ADD CONSTRAINT "RecoveryCodeSet_issuance_operation_id_canonical" CHECK ("issuanceOperationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_consumed_operation_id_canonical" CHECK ("consumedOperationId" IS NULL OR "consumedOperationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "RecoverySession" ADD CONSTRAINT "RecoverySession_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "GlobalSecurityOperationBinding" ADD CONSTRAINT "GlobalSecurityOperationBinding_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "GlobalSecurityOperation" ADD CONSTRAINT "GlobalSecurityOperation_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "GlobalSecurityOperationTombstone" ADD CONSTRAINT "GlobalSecurityOperationTombstone_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "GlobalSecurityOperationReservationTombstone" ADD CONSTRAINT "GlobalSecurityOperationReservationTombstone_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "EmailChange" ADD CONSTRAINT "EmailChange_operation_id_canonical" CHECK ("operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');
ALTER TABLE "GlobalSecurityEvent" ADD CONSTRAINT "GlobalSecurityEvent_operation_id_canonical" CHECK ("operationId" IS NULL OR "operationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$');

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_state_idx" ON "RecoveryCode"("userId", "state");
CREATE INDEX "RecoveryCodeSet_userId_state_idx" ON "RecoveryCodeSet"("userId", "state");
CREATE UNIQUE INDEX "RecoveryCodeSet_freshAuthGrantId_key" ON "RecoveryCodeSet"("freshAuthGrantId");
CREATE UNIQUE INDEX "RecoveryCodeSet_userId_issuanceOperationId_key" ON "RecoveryCodeSet"("userId", "issuanceOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_userId_setVersion_ordinal_key" ON "RecoveryCode"("userId", "setVersion", "ordinal");
CREATE UNIQUE INDEX "RecoveryCode_userId_id_key" ON "RecoveryCode"("userId", "id");
CREATE UNIQUE INDEX "RecoveryCode_userId_consumedOperationId_key" ON "RecoveryCode"("userId", "consumedOperationId");
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 10);
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_salt_length_check" CHECK (octet_length("salt") = 16);
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_derived_key_length_check" CHECK (octet_length("derivedKey") = 32);
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_kdf_version_check" CHECK ("kdfVersion" = 1);

-- CreateIndex
CREATE INDEX "RecoverySession_recoveryCodeId_idx" ON "RecoverySession"("recoveryCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoverySession_userId_operationId_key" ON "RecoverySession"("userId", "operationId");
CREATE UNIQUE INDEX "RecoverySession_userId_recoveryCodeId_key" ON "RecoverySession"("userId", "recoveryCodeId");
CREATE UNIQUE INDEX "RecoverySession_attestationNonce_key" ON "RecoverySession"("attestationNonce");

-- CreateIndex
CREATE INDEX "GlobalSecurityOperationBinding_sessionId_idx" ON "GlobalSecurityOperationBinding"("sessionId");

CREATE INDEX "GlobalSecurityOperationBinding_recoverySessionId_idx" ON "GlobalSecurityOperationBinding"("recoverySessionId");

-- CreateIndex
CREATE INDEX "GlobalSecurityOperationBinding_state_expiresAt_idx" ON "GlobalSecurityOperationBinding"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSecurityOperationBinding_userId_operationId_key" ON "GlobalSecurityOperationBinding"("userId", "operationId");
ALTER TABLE "GlobalSecurityOperationBinding" ADD CONSTRAINT "GlobalSecurityOperationBinding_recovery_session_shape" CHECK (("operationKey" = 'recovery_reset' AND "sessionId" IS NULL AND "recoverySessionId" IS NOT NULL) OR ("operationKey" <> 'recovery_reset' AND "sessionId" IS NOT NULL AND "recoverySessionId" IS NULL));
ALTER TABLE "GlobalSecurityOperationReservationTombstone" ADD CONSTRAINT "GlobalSecurityOperationReservationTombstone_recovery_session_shape" CHECK (("operationKey" = 'recovery_reset' AND "sessionId" IS NULL AND "recoverySessionId" IS NOT NULL) OR ("operationKey" <> 'recovery_reset' AND "sessionId" IS NOT NULL AND "recoverySessionId" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSecurityOperation_bindingId_key" ON "GlobalSecurityOperation"("bindingId");

-- CreateIndex
CREATE INDEX "GlobalSecurityOperation_status_createdAt_idx" ON "GlobalSecurityOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GlobalSecurityEvent_userId_createdAt_idx" ON "GlobalSecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GlobalSecurityIncident_userId_createdAt_idx" ON "GlobalSecurityIncident"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSecurityIncident_layer_normalizedKey_windowStartedAt_key" ON "GlobalSecurityIncident"("layer", "normalizedKey", "windowStartedAt");

-- CreateIndex
CREATE INDEX "EmailChange_normalizedNewEmail_state_idx" ON "EmailChange"("normalizedNewEmail", "state");

-- CreateIndex
CREATE UNIQUE INDEX "EmailChange_userId_operationId_key" ON "EmailChange"("userId", "operationId");

-- CreateIndex
CREATE INDEX "SessionSecurityActivity_userId_state_idx" ON "SessionSecurityActivity"("userId", "state");

-- AddForeignKey
ALTER TABLE "AccountSecurityState" ADD CONSTRAINT "AccountSecurityState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreshAuthGrant" ADD CONSTRAINT "FreshAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCodeSet" ADD CONSTRAINT "RecoveryCodeSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCodeSet" ADD CONSTRAINT "RecoveryCodeSet_freshAuthGrantId_fkey" FOREIGN KEY ("freshAuthGrantId") REFERENCES "FreshAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCodeSet" ADD CONSTRAINT "RecoveryCodeSet_userId_issuanceOperationId_fkey" FOREIGN KEY ("userId","issuanceOperationId") REFERENCES "GlobalSecurityOperation"("userId","operationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_setVersion_fkey" FOREIGN KEY ("userId","setVersion") REFERENCES "RecoveryCodeSet"("userId","setVersion") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoverySession" ADD CONSTRAINT "RecoverySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityOperationBinding" ADD CONSTRAINT "GlobalSecurityOperationBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityOperation" ADD CONSTRAINT "GlobalSecurityOperation_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "GlobalSecurityOperationBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityOperation" ADD CONSTRAINT "GlobalSecurityOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityOperationTombstone" ADD CONSTRAINT "GlobalSecurityOperationTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityOperationReservationTombstone" ADD CONSTRAINT "GlobalSecurityOperationReservationTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "GlobalSecurityEvent" ADD CONSTRAINT "GlobalSecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSecurityIncident" ADD CONSTRAINT "GlobalSecurityIncident_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailChange" ADD CONSTRAINT "EmailChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailChange" ADD CONSTRAINT "EmailChange_freshAuthGrantId_fkey" FOREIGN KEY ("freshAuthGrantId") REFERENCES "FreshAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSecurityActivity" ADD CONSTRAINT "SessionSecurityActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Session_userId_id_key" ON "Session"("userId", "id");
CREATE UNIQUE INDEX "SessionSecurityActivity_userId_sessionId_key" ON "SessionSecurityActivity"("userId", "sessionId");

ALTER TABLE "AccountSecurityState" ADD CONSTRAINT "AccountSecurityState_versions_check" CHECK ("credentialVersion" > 0 AND "sessionSecurityVersion" > 0);
CREATE UNIQUE INDEX "FreshAuthGrant_one_live_purpose" ON "FreshAuthGrant"("userId", "purpose") WHERE "state" = 'issued';
CREATE UNIQUE INDEX "EmailChange_one_live_change" ON "EmailChange"("userId") WHERE "state" IN ('pending', 'verified');
ALTER TABLE "GlobalSecurityOperation" ADD CONSTRAINT "GlobalSecurityOperation_state_outcome_check" CHECK (("status" IN ('pending', 'unknown') AND "terminalAt" IS NULL AND "outcomeVersion" IS NULL AND "outcomeCode" IS NULL AND "outcomeSnapshot" IS NULL) OR ("status" IN ('completed', 'rejected', 'stale') AND "terminalAt" IS NOT NULL AND "outcomeVersion" = 1 AND "outcomeCode" IS NOT NULL AND "outcomeSnapshot" IS NOT NULL));

CREATE FUNCTION "lock_global_security_operation_identity_v1"(scope_user_id TEXT, operation_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  identity_text TEXT := 'global-security-operation:v1:' || scope_user_id || ':' || operation_id;
BEGIN
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 1, 16))::bit(64)::bigint));
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(identity_text), 17, 16))::bit(64)::bigint));
END
$$;

CREATE FUNCTION "prevent_global_security_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'global_security_event_append_only';
END
$$;

CREATE TRIGGER "GlobalSecurityEvent_append_only"
BEFORE UPDATE OR DELETE ON "GlobalSecurityEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_event_mutation"();

REVOKE ALL ON FUNCTION "lock_global_security_operation_identity_v1"(TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION "assert_global_security_binding_current_authorization"(scope_user_id TEXT, scope_session_id TEXT, scope_recovery_session_id TEXT, scope_operation_id TEXT, scope_operation_key "GlobalSecurityOperationKey", expected_version INTEGER, expected_session_version INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; session_row "Session"%ROWTYPE; recovery_row "RecoverySession"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  IF scope_operation_key = 'recovery_reset' THEN
    IF scope_session_id IS NOT NULL OR scope_recovery_session_id IS NULL THEN RAISE EXCEPTION 'global_security_recovery_binding_authorization_required'; END IF;
    SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=scope_recovery_session_id AND "userId"=scope_user_id FOR UPDATE;
    IF recovery_row."id" IS NULL OR recovery_row."operationId" IS DISTINCT FROM scope_operation_id OR recovery_row."purpose" <> 'recovery_reset' OR recovery_row."state" <> 'restricted' OR recovery_row."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'global_security_recovery_binding_authorization_required'; END IF;
  ELSE
    IF scope_session_id IS NULL OR scope_recovery_session_id IS NOT NULL THEN RAISE EXCEPTION 'global_security_binding_current_authorization_required'; END IF;
    SELECT * INTO session_row FROM "Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE;
  END IF;
  IF state_row."userId" IS NULL OR state_row."credentialVersion" IS DISTINCT FROM expected_version OR state_row."sessionSecurityVersion" IS DISTINCT FROM expected_session_version OR (scope_operation_key <> 'recovery_reset' AND (session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp())) THEN RAISE EXCEPTION 'global_security_binding_current_authorization_required'; END IF;
END $$;

CREATE FUNCTION "assert_global_security_stale_finalization"(scope_user_id TEXT, scope_session_id TEXT, scope_recovery_session_id TEXT, scope_operation_id TEXT, scope_operation_key "GlobalSecurityOperationKey", expected_version INTEGER, expected_session_version INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; recovery_row "RecoverySession"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  IF state_row."userId" IS NULL OR (expected_version IS NOT DISTINCT FROM state_row."credentialVersion" AND expected_session_version IS NOT DISTINCT FROM state_row."sessionSecurityVersion") OR scope_operation_key NOT IN ('password_change','recovery_reset','email_change','session_revoke') OR state_row."lastCredentialOperationId" IS NOT DISTINCT FROM scope_operation_id OR state_row."lastSessionSecurityOperationId" IS NOT DISTINCT FROM scope_operation_id THEN RAISE EXCEPTION 'global_security_stale_finalization_invalid'; END IF;
  IF scope_operation_key = 'recovery_reset' THEN
    IF scope_session_id IS NOT NULL OR scope_recovery_session_id IS NULL THEN RAISE EXCEPTION 'global_security_stale_finalization_invalid'; END IF;
    SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=scope_recovery_session_id AND "userId"=scope_user_id FOR UPDATE;
    IF recovery_row."id" IS NULL OR recovery_row."operationId" IS DISTINCT FROM scope_operation_id OR recovery_row."purpose" <> 'recovery_reset' THEN RAISE EXCEPTION 'global_security_stale_finalization_invalid'; END IF;
  ELSIF scope_session_id IS NULL OR scope_recovery_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'global_security_stale_finalization_invalid';
  END IF;
END $$;

CREATE FUNCTION "global_security_terminal_outcome_valid"(operation_key "GlobalSecurityOperationKey", terminal_status "GlobalSecurityOperationStatus", outcome_code TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT (operation_key, terminal_status, outcome_code) IN (
    ('password_change'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'changed'),
    ('password_change'::"GlobalSecurityOperationKey", 'stale'::"GlobalSecurityOperationStatus", 'stale_security_version'),
    ('password_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'grant_expired'),
    ('password_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'current_password_invalid'),
    ('password_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'operation_conflict'),
    ('recovery_enrollment'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'rehearsal_completed'),
    ('recovery_enrollment'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'rehearsal_failed'),
    ('recovery_reset'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'reset_completed'),
    ('recovery_reset'::"GlobalSecurityOperationKey", 'stale'::"GlobalSecurityOperationStatus", 'stale_security_version'),
    ('recovery_reset'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'recovery_set_regenerated'),
    ('recovery_reset'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'recovery_session_expired'),
    ('email_change'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'cutover_completed'),
    ('email_change'::"GlobalSecurityOperationKey", 'stale'::"GlobalSecurityOperationStatus", 'stale_security_version'),
    ('email_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'verification_expired'),
    ('email_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'collision_rejected'),
    ('email_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'cancelled'),
    ('email_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'delivery_failed'),
    ('email_change'::"GlobalSecurityOperationKey", 'rejected'::"GlobalSecurityOperationStatus", 'abandoned'),
    ('session_revoke'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'revoked'),
    ('session_revoke'::"GlobalSecurityOperationKey", 'completed'::"GlobalSecurityOperationStatus", 'already_revoked'),
    ('session_revoke'::"GlobalSecurityOperationKey", 'stale'::"GlobalSecurityOperationStatus", 'stale_security_version')
  )
$$;

CREATE FUNCTION "guard_global_security_binding_insert"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  state_row "AccountSecurityState"%ROWTYPE;
  session_row "Session"%ROWTYPE;
  recovery_row "RecoverySession"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId" = NEW."userId" FOR UPDATE;
  IF NEW."operationKey" = 'recovery_reset' THEN
    IF NEW."sessionId" IS NOT NULL OR NEW."recoverySessionId" IS NULL THEN RAISE EXCEPTION 'global_security_recovery_binding_authorization_required'; END IF;
    SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=NEW."recoverySessionId" AND "userId"=NEW."userId" FOR UPDATE;
    IF recovery_row."id" IS NULL OR recovery_row."operationId" IS DISTINCT FROM NEW."operationId" OR recovery_row."purpose" <> 'recovery_reset' OR recovery_row."state" <> 'restricted' OR recovery_row."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'global_security_recovery_binding_authorization_required'; END IF;
    NEW."expiresAt" := recovery_row."expiresAt";
  ELSE
    IF NEW."sessionId" IS NULL OR NEW."recoverySessionId" IS NOT NULL THEN RAISE EXCEPTION 'global_security_binding_initial_state_invalid'; END IF;
    SELECT * INTO session_row FROM "Session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId" FOR UPDATE;
    NEW."expiresAt" := NEW."createdAt" + INTERVAL '10 minutes';
  END IF;
  IF NEW."state" <> 'open'
    OR NEW."expiresAt" <= NEW."createdAt"
    OR NEW."expiresAt" <= clock_timestamp()
    OR NEW."expiresAt" > NEW."createdAt" + INTERVAL '10 minutes'
    OR state_row."userId" IS NULL
    OR state_row."credentialVersion" IS DISTINCT FROM NEW."securityVersion"
    OR state_row."sessionSecurityVersion" IS DISTINCT FROM NEW."sessionSecurityVersion"
    OR (NEW."operationKey" <> 'recovery_reset' AND (session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp()))
  THEN
    RAISE EXCEPTION 'global_security_binding_initial_state_invalid';
  END IF;
  PERFORM "lock_global_security_operation_identity_v1"(NEW."userId", NEW."operationId");
  IF EXISTS (SELECT 1 FROM "GlobalSecurityOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") OR EXISTS (SELECT 1 FROM "GlobalSecurityOperationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") OR EXISTS (SELECT 1 FROM "GlobalSecurityOperationReservationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") THEN
    RAISE EXCEPTION 'global_security_operation_identity_already_owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "guard_global_security_operation_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'pending'
    OR NEW."outcomeVersion" IS NOT NULL
    OR NEW."outcomeCode" IS NOT NULL
    OR NEW."outcomeSnapshot" IS NOT NULL
    OR NEW."terminalAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'global_security_operation_initial_state_invalid';
  END IF;
  PERFORM "lock_global_security_operation_identity_v1"(NEW."userId", NEW."operationId");
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id" = NEW."bindingId" FOR UPDATE;
  IF NOT FOUND OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."operationId" IS DISTINCT FROM NEW."operationId" OR bound."operationKey" IS DISTINCT FROM NEW."operationKey" OR bound."state" <> 'open' THEN RAISE EXCEPTION 'global_security_operation_binding_mismatch' USING ERRCODE = '23514'; END IF;
  IF bound."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'global_security_binding_claim_after_expiry'; END IF;
  PERFORM "assert_global_security_binding_current_authorization"(bound."userId", bound."sessionId", bound."recoverySessionId", bound."operationId", bound."operationKey", bound."securityVersion", bound."sessionSecurityVersion");
  RETURN NEW;
END $$;

CREATE FUNCTION "guard_global_security_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  PERFORM "lock_global_security_operation_identity_v1"(NEW."userId", NEW."operationId");
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id" = operation_row."bindingId" FOR UPDATE;
  IF NOT FOUND OR bound."state" <> 'terminal' OR operation_row."operationKey" IS DISTINCT FROM NEW."operationKey" OR operation_row."intentFingerprint" IS DISTINCT FROM NEW."intentFingerprint" OR operation_row."status" NOT IN ('completed', 'rejected', 'stale') OR operation_row."outcomeCode" IS DISTINCT FROM NEW."terminalCode" OR operation_row."terminalAt" IS DISTINCT FROM NEW."terminalAt" THEN RAISE EXCEPTION 'global_security_tombstone_mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_global_security_operation_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'global_security_operation_write_once'; END IF;
  IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."operationKey" IS DISTINCT FROM OLD."operationKey" OR NEW."intentFingerprint" IS DISTINCT FROM OLD."intentFingerprint" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'global_security_operation_immutable_identity'; END IF;
  IF OLD."status" NOT IN ('pending', 'unknown') OR NEW."status" NOT IN ('completed', 'rejected', 'stale') OR NEW."terminalAt" IS NULL THEN RAISE EXCEPTION 'global_security_operation_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_global_security_binding_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'global_security_binding_write_once'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."recoverySessionId" IS DISTINCT FROM OLD."recoverySessionId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."operationKey" IS DISTINCT FROM OLD."operationKey" OR NEW."securityVersion" IS DISTINCT FROM OLD."securityVersion" OR NEW."openingFingerprint" IS DISTINCT FROM OLD."openingFingerprint" OR NEW."targetSnapshot" IS DISTINCT FROM OLD."targetSnapshot" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'global_security_binding_immutable_identity'; END IF;
  IF OLD."state" = 'open' AND NEW."state" = 'submitted' THEN SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId" FOR UPDATE; IF NOT FOUND OR operation_row."status" NOT IN ('pending', 'unknown') THEN RAISE EXCEPTION 'global_security_binding_missing_submitted_operation'; END IF; END IF;
  IF OLD."state" = 'submitted' AND NEW."state" = 'terminal' THEN SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId" FOR UPDATE; IF NOT FOUND OR operation_row."status" NOT IN ('completed', 'rejected', 'stale') THEN RAISE EXCEPTION 'global_security_binding_missing_terminal_operation'; END IF; END IF;
  IF (OLD."state" = 'open' AND NEW."state" NOT IN ('submitted', 'expired', 'revoked')) OR (OLD."state" = 'submitted' AND NEW."state" <> 'terminal') OR OLD."state" IN ('terminal', 'expired', 'revoked') THEN RAISE EXCEPTION 'global_security_binding_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "GlobalSecurityBinding_identity_insert_guard" BEFORE INSERT ON "GlobalSecurityOperationBinding" FOR EACH ROW EXECUTE FUNCTION "guard_global_security_binding_insert"();
CREATE TRIGGER "GlobalSecurityOperation_binding_claim_guard" BEFORE INSERT ON "GlobalSecurityOperation" FOR EACH ROW EXECUTE FUNCTION "guard_global_security_operation_insert"();
CREATE TRIGGER "GlobalSecurityTombstone_insert_guard" BEFORE INSERT ON "GlobalSecurityOperationTombstone" FOR EACH ROW EXECUTE FUNCTION "guard_global_security_tombstone_insert"();
CREATE TRIGGER "GlobalSecurityBinding_write_once" BEFORE UPDATE OR DELETE ON "GlobalSecurityOperationBinding" FOR EACH ROW EXECUTE FUNCTION "enforce_global_security_binding_write_once"();
CREATE TRIGGER "GlobalSecurityOperation_terminal_write_once" BEFORE UPDATE OR DELETE ON "GlobalSecurityOperation" FOR EACH ROW EXECUTE FUNCTION "enforce_global_security_operation_write_once"();

CREATE FUNCTION "guard_global_security_reservation_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  PERFORM "lock_global_security_operation_identity_v1"(NEW."userId", NEW."operationId");
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId" FOR UPDATE;
  IF NOT FOUND OR bound."state" <> 'expired' OR bound."sessionId" IS DISTINCT FROM NEW."sessionId" OR bound."recoverySessionId" IS DISTINCT FROM NEW."recoverySessionId" OR bound."operationKey" IS DISTINCT FROM NEW."operationKey" OR bound."openingFingerprint" IS DISTINCT FROM NEW."openingFingerprint" OR EXISTS (SELECT 1 FROM "GlobalSecurityOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") OR EXISTS (SELECT 1 FROM "GlobalSecurityOperationTombstone" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId") THEN RAISE EXCEPTION 'global_security_reservation_tombstone_mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW."terminalCode" <> 'reservation_expired' OR NEW."terminalAt" < bound."expiresAt" OR NEW."terminalAt" > clock_timestamp() + INTERVAL '1 millisecond' THEN RAISE EXCEPTION 'global_security_reservation_tombstone_terminal_invalid'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "prevent_global_security_tombstone_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'global_security_tombstone_write_once';
END $$;

CREATE FUNCTION "enforce_fresh_auth_grant_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."credentialVersion" IS DISTINCT FROM OLD."credentialVersion" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN RAISE EXCEPTION 'fresh_auth_grant_immutable_binding'; END IF;
  IF OLD."state" <> 'issued' OR NEW."state" NOT IN ('consumed', 'revoked', 'expired') THEN RAISE EXCEPTION 'fresh_auth_grant_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_recovery_code_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."setVersion" IS DISTINCT FROM OLD."setVersion" OR NEW."codeDigest" IS DISTINCT FROM OLD."codeDigest" OR NEW."salt" IS DISTINCT FROM OLD."salt" OR NEW."kdfVersion" IS DISTINCT FROM OLD."kdfVersion" THEN RAISE EXCEPTION 'recovery_code_immutable_binding'; END IF;
  IF OLD."state" <> 'active' OR NEW."state" NOT IN ('consumed', 'invalidated') THEN RAISE EXCEPTION 'recovery_code_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_email_change_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."normalizedNewEmail" IS DISTINCT FROM OLD."normalizedNewEmail" OR NEW."verificationDigest" IS DISTINCT FROM OLD."verificationDigest" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN RAISE EXCEPTION 'email_change_immutable_binding'; END IF;
  IF OLD."state" <> 'pending' OR NEW."state" NOT IN ('verified', 'cancelled', 'expired', 'abandoned', 'failed') THEN RAISE EXCEPTION 'email_change_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "GlobalSecurityReservationTombstone_insert_guard" BEFORE INSERT ON "GlobalSecurityOperationReservationTombstone" FOR EACH ROW EXECUTE FUNCTION "guard_global_security_reservation_tombstone_insert"();
CREATE TRIGGER "GlobalSecurityOperationTombstone_write_once" BEFORE UPDATE OR DELETE ON "GlobalSecurityOperationTombstone" FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_tombstone_mutation"();
CREATE TRIGGER "GlobalSecurityReservationTombstone_write_once" BEFORE UPDATE OR DELETE ON "GlobalSecurityOperationReservationTombstone" FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_tombstone_mutation"();
CREATE TRIGGER "FreshAuthGrant_state_guard" BEFORE UPDATE ON "FreshAuthGrant" FOR EACH ROW EXECUTE FUNCTION "enforce_fresh_auth_grant_transition"();
CREATE TRIGGER "RecoveryCode_single_consume" BEFORE UPDATE ON "RecoveryCode" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_transition"();
CREATE TRIGGER "EmailChange_state_guard" BEFORE UPDATE ON "EmailChange" FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_transition"();

CREATE FUNCTION "enforce_account_security_version_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'account_security_state_delete_forbidden'; END IF;
  IF NEW."credentialVersion" < OLD."credentialVersion" OR NEW."sessionSecurityVersion" < OLD."sessionSecurityVersion" THEN RAISE EXCEPTION 'account_security_version_regression'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_recovery_session_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'recovery_session_write_once'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."recoveryCodeId" IS DISTINCT FROM OLD."recoveryCodeId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN RAISE EXCEPTION 'recovery_session_immutable_binding'; END IF;
  IF OLD."state" <> 'restricted' OR NEW."state" NOT IN ('consumed', 'closed', 'expired') THEN RAISE EXCEPTION 'recovery_session_invalid_transition'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "AccountSecurityState_version_guard" BEFORE UPDATE OR DELETE ON "AccountSecurityState" FOR EACH ROW EXECUTE FUNCTION "enforce_account_security_version_transition"();
CREATE TRIGGER "RecoverySession_state_guard" BEFORE UPDATE OR DELETE ON "RecoverySession" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_session_transition"();

CREATE OR REPLACE FUNCTION "enforce_account_security_version_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'account_security_state_delete_forbidden';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."credentialVersion" <> 1 OR NEW."sessionSecurityVersion" <> 1 THEN
      RAISE EXCEPTION 'account_security_state_initial_version_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'account_security_state_identity_immutable'; END IF;
  IF NEW."credentialVersion" < OLD."credentialVersion" OR NEW."sessionSecurityVersion" < OLD."sessionSecurityVersion" THEN
    RAISE EXCEPTION 'account_security_version_regression';
  END IF;
  IF (NEW."credentialVersion" > OLD."credentialVersion" AND (NEW."lastCredentialOperationId" IS NULL OR NEW."lastCredentialOperationId" IS NOT DISTINCT FROM OLD."lastCredentialOperationId")) OR (NEW."credentialVersion" = OLD."credentialVersion" AND NEW."lastCredentialOperationId" IS DISTINCT FROM OLD."lastCredentialOperationId") OR (NEW."sessionSecurityVersion" > OLD."sessionSecurityVersion" AND (NEW."lastSessionSecurityOperationId" IS NULL OR NEW."lastSessionSecurityOperationId" IS NOT DISTINCT FROM OLD."lastSessionSecurityOperationId")) OR (NEW."sessionSecurityVersion" = OLD."sessionSecurityVersion" AND NEW."lastSessionSecurityOperationId" IS DISTINCT FROM OLD."lastSessionSecurityOperationId") THEN
    RAISE EXCEPTION 'account_security_version_attribution_required';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "assert_session_revoke_success_finalization"(scope_user_id TEXT, scope_operation_id TEXT, bound "GlobalSecurityOperationBinding")
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE; revoke_scope TEXT; resolved_target TEXT;
BEGIN
  revoke_scope:=bound."targetSnapshot"->>'scope'; resolved_target:=bound."targetSnapshot"->>'resolvedTargetSessionId';
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "userId"=scope_user_id AND "sessionId"=bound."sessionId" AND "operationId"=scope_operation_id AND "purpose"='session_revoke' AND "credentialVersion"=bound."securityVersion" FOR UPDATE;
  IF state_row."userId" IS NULL OR grant_row."id" IS NULL OR grant_row."state"<>'consumed' OR revoke_scope NOT IN ('current','one','others','all') THEN RAISE EXCEPTION 'session_revoke_success_finalization_required'; END IF;
  IF revoke_scope='current' THEN
    IF EXISTS (SELECT 1 FROM "Session" WHERE "id"=bound."sessionId" AND "userId"=scope_user_id) OR state_row."credentialVersion" IS DISTINCT FROM bound."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion" THEN RAISE EXCEPTION 'session_revoke_success_finalization_required'; END IF;
  ELSIF revoke_scope='one' THEN
    IF EXISTS (SELECT 1 FROM "Session" WHERE "id"=resolved_target AND "userId"=scope_user_id) OR state_row."credentialVersion" IS DISTINCT FROM bound."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion" THEN RAISE EXCEPTION 'session_revoke_success_finalization_required'; END IF;
  ELSIF revoke_scope='others' THEN
    IF EXISTS (SELECT 1 FROM "Session" WHERE "userId"=scope_user_id AND "id"<>bound."sessionId") OR state_row."credentialVersion" IS DISTINCT FROM bound."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion" THEN RAISE EXCEPTION 'session_revoke_success_finalization_required'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "Session" WHERE "userId"=scope_user_id) OR state_row."credentialVersion" IS DISTINCT FROM bound."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion"+1 OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM scope_operation_id THEN RAISE EXCEPTION 'session_revoke_success_finalization_required'; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "enforce_global_security_operation_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'global_security_operation_write_once';
  END IF;
  PERFORM "lock_global_security_operation_identity_v1"(OLD."userId", OLD."operationId");
  IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."operationKey" IS DISTINCT FROM OLD."operationKey" OR NEW."intentFingerprint" IS DISTINCT FROM OLD."intentFingerprint" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'global_security_operation_immutable_identity';
  END IF;
  IF NEW."status" = 'completed' AND NOT ((NEW."operationKey" = 'password_change' AND NEW."outcomeCode" = 'changed') OR (NEW."operationKey" = 'recovery_enrollment' AND NEW."outcomeCode" = 'rehearsal_completed') OR (NEW."operationKey" = 'recovery_reset' AND NEW."outcomeCode" = 'reset_completed') OR (NEW."operationKey" = 'email_change' AND NEW."outcomeCode" = 'cutover_completed') OR (NEW."operationKey" = 'session_revoke' AND NEW."outcomeCode" IN ('revoked','already_revoked'))) THEN RAISE EXCEPTION 'global_security_success_finalization_not_enabled'; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id" = OLD."bindingId" FOR UPDATE;
  IF NOT FOUND OR bound."userId" IS DISTINCT FROM OLD."userId" OR bound."operationId" IS DISTINCT FROM OLD."operationId" OR bound."operationKey" IS DISTINCT FROM OLD."operationKey" THEN
    RAISE EXCEPTION 'global_security_operation_binding_mismatch';
  END IF;
  IF NEW."status" = 'completed' AND NEW."operationKey" = 'session_revoke' THEN
    PERFORM "assert_session_revoke_success_finalization"(OLD."userId", OLD."operationId", bound);
  ELSIF NEW."status" = 'rejected' AND NEW."outcomeCode" = 'recovery_session_expired' THEN
    PERFORM "assert_recovery_session_expiry_finalization"(bound."userId", bound."recoverySessionId", bound."operationId");
  ELSIF NEW."status" = 'stale' AND NEW."outcomeCode" = 'stale_security_version' THEN
    PERFORM "assert_global_security_stale_finalization"(bound."userId", bound."sessionId", bound."recoverySessionId", bound."operationId", bound."operationKey", bound."securityVersion", bound."sessionSecurityVersion");
  ELSIF NEW."status" <> 'completed' THEN
    PERFORM "assert_global_security_binding_current_authorization"(bound."userId", bound."sessionId", bound."recoverySessionId", bound."operationId", bound."operationKey", bound."securityVersion", bound."sessionSecurityVersion");
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'unknown' THEN
    IF bound."state" <> 'submitted' THEN RAISE EXCEPTION 'global_security_operation_missing_submitted_binding'; END IF;
  ELSIF OLD."status" IN ('pending', 'unknown') AND NEW."status" IN ('completed', 'rejected', 'stale') THEN
    IF bound."state" <> 'submitted' THEN RAISE EXCEPTION 'global_security_operation_missing_submitted_binding'; END IF;
  ELSE
    RAISE EXCEPTION 'global_security_operation_invalid_transition';
  END IF;
  IF NEW."status" IN ('completed','rejected','stale') AND NOT "global_security_terminal_outcome_valid"(NEW."operationKey", NEW."status", NEW."outcomeCode") THEN RAISE EXCEPTION 'global_security_terminal_outcome_invalid'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_global_security_binding_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'global_security_binding_write_once';
  END IF;
  PERFORM "lock_global_security_operation_identity_v1"(OLD."userId", OLD."operationId");
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."recoverySessionId" IS DISTINCT FROM OLD."recoverySessionId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."operationKey" IS DISTINCT FROM OLD."operationKey" OR NEW."securityVersion" IS DISTINCT FROM OLD."securityVersion" OR NEW."sessionSecurityVersion" IS DISTINCT FROM OLD."sessionSecurityVersion" OR NEW."openingFingerprint" IS DISTINCT FROM OLD."openingFingerprint" OR NEW."targetSnapshot" IS DISTINCT FROM OLD."targetSnapshot" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'global_security_binding_immutable_identity';
  END IF;
  IF OLD."state" = 'open' AND NEW."state" = 'submitted' THEN
    IF OLD."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'global_security_binding_claim_after_expiry'; END IF;
    PERFORM "assert_global_security_binding_current_authorization"(OLD."userId", OLD."sessionId", OLD."recoverySessionId", OLD."operationId", OLD."operationKey", OLD."securityVersion", OLD."sessionSecurityVersion");
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId" FOR UPDATE;
    IF NOT FOUND OR operation_row."bindingId" IS DISTINCT FROM OLD."id" OR operation_row."operationKey" IS DISTINCT FROM OLD."operationKey" OR operation_row."status" NOT IN ('pending', 'unknown') THEN
      RAISE EXCEPTION 'global_security_binding_missing_submitted_operation';
    END IF;
  ELSIF OLD."state" = 'submitted' AND NEW."state" = 'terminal' THEN
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = OLD."userId" AND "operationId" = OLD."operationId" FOR UPDATE;
    IF NOT FOUND OR operation_row."bindingId" IS DISTINCT FROM OLD."id" OR operation_row."operationKey" IS DISTINCT FROM OLD."operationKey" OR operation_row."status" NOT IN ('completed', 'rejected', 'stale') THEN
      RAISE EXCEPTION 'global_security_binding_missing_terminal_operation';
    END IF;
    IF operation_row."status" = 'rejected' AND operation_row."outcomeCode" = 'recovery_session_expired' THEN
      PERFORM "assert_recovery_session_expiry_finalization"(OLD."userId", OLD."recoverySessionId", OLD."operationId");
    ELSIF operation_row."status" = 'stale' AND operation_row."outcomeCode" = 'stale_security_version' THEN
      PERFORM "assert_global_security_stale_finalization"(OLD."userId", OLD."sessionId", OLD."recoverySessionId", OLD."operationId", OLD."operationKey", OLD."securityVersion", OLD."sessionSecurityVersion");
    ELSIF operation_row."status" <> 'completed' THEN
      PERFORM "assert_global_security_binding_current_authorization"(OLD."userId", OLD."sessionId", OLD."recoverySessionId", OLD."operationId", OLD."operationKey", OLD."securityVersion", OLD."sessionSecurityVersion");
    END IF;
  ELSIF OLD."state" = 'open' AND NEW."state" = 'expired' THEN
    IF OLD."expiresAt" > clock_timestamp() THEN RAISE EXCEPTION 'global_security_binding_expired_before_deadline'; END IF;
  ELSIF NOT (OLD."state" = 'open' AND NEW."state" = 'revoked') THEN
    RAISE EXCEPTION 'global_security_binding_invalid_transition';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "verify_password_fresh_auth_attestation"(scope_user_id TEXT, scope_session_id TEXT, scope_operation_id TEXT, scope_purpose TEXT, scope_credential_version INTEGER, scope_session_security_version INTEGER, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT, scope_replacement_digest BYTEA, scope_nonce TEXT, scope_key_version INTEGER, scope_mac BYTEA)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE key_row public."FreshAuthAttestationKey"%ROWTYPE; payload TEXT;
BEGIN
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_key_version AND "active"=true AND ("rotatedAt" IS NULL OR "rotatedAt">clock_timestamp()-INTERVAL '10 minutes');
  IF key_row."keyVersion" IS NULL OR scope_replacement_digest IS NULL OR octet_length(scope_replacement_digest)<>32 OR scope_nonce !~ '^[A-Za-z0-9_-]{43}$' OR scope_mac IS NULL OR octet_length(scope_mac)<>32 THEN RETURN false; END IF;
  IF scope_purpose NOT IN ('password_change','recovery_enrollment') THEN RETURN false; END IF;
  payload := concat_ws('|','fresh-auth-attestation-v1',encode(convert_to(scope_user_id,'UTF8'),'hex'),encode(convert_to(scope_session_id,'UTF8'),'hex'),encode(convert_to(scope_operation_id,'UTF8'),'hex'),scope_purpose,scope_credential_version::text,scope_session_security_version::text,encode(convert_to(scope_opening_fingerprint,'UTF8'),'hex'),encode(convert_to(scope_intent_fingerprint,'UTF8'),'hex'),encode(scope_replacement_digest,'hex'),encode(convert_to(scope_nonce,'UTF8'),'hex'),scope_key_version::text);
  RETURN public.hmac(convert_to(payload,'UTF8'),key_row."verificationKey",'sha256')=scope_mac;
END $$;
REVOKE ALL ON FUNCTION "verify_password_fresh_auth_attestation"(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT,BYTEA,TEXT,INTEGER,BYTEA) FROM PUBLIC;

CREATE FUNCTION "verify_session_revoke_attestation"(scope_user_id TEXT, scope_session_id TEXT, scope_operation_id TEXT, scope_credential_version INTEGER, scope_session_security_version INTEGER, scope_scope TEXT, scope_target_handle TEXT, scope_target_session_id TEXT, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT, scope_nonce TEXT, scope_key_version INTEGER, scope_mac BYTEA)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE key_row public."FreshAuthAttestationKey"%ROWTYPE; payload TEXT;
BEGIN
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_key_version AND "active"=true AND ("rotatedAt" IS NULL OR "rotatedAt">clock_timestamp()-INTERVAL '10 minutes');
  IF key_row."keyVersion" IS NULL OR scope_scope NOT IN ('current','one','others','all') OR scope_nonce !~ '^[A-Za-z0-9_-]{43}$' OR scope_mac IS NULL OR octet_length(scope_mac)<>32 THEN RETURN false; END IF;
  IF (scope_scope IN ('current','one') AND (scope_target_handle IS NULL OR scope_target_session_id IS NULL)) OR (scope_scope IN ('others','all') AND (scope_target_handle IS DISTINCT FROM 'absent_target_handle' OR scope_target_session_id IS DISTINCT FROM 'absent_target_session_id')) THEN RETURN false; END IF;
  payload := concat_ws('|','session-revoke-attestation-v1',encode(convert_to(scope_user_id,'UTF8'),'hex'),encode(convert_to(scope_session_id,'UTF8'),'hex'),encode(convert_to(scope_operation_id,'UTF8'),'hex'),'session_revoke',scope_credential_version::text,scope_session_security_version::text,scope_scope,encode(convert_to(scope_target_handle,'UTF8'),'hex'),encode(convert_to(scope_target_session_id,'UTF8'),'hex'),encode(convert_to(scope_opening_fingerprint,'UTF8'),'hex'),encode(convert_to(scope_intent_fingerprint,'UTF8'),'hex'),encode(convert_to(scope_nonce,'UTF8'),'hex'),scope_key_version::text);
  RETURN public.hmac(convert_to(payload,'UTF8'),key_row."verificationKey",'sha256')=scope_mac;
END $$;
REVOKE ALL ON FUNCTION "verify_session_revoke_attestation"(TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BYTEA) FROM PUBLIC;

CREATE FUNCTION "enforce_fresh_auth_grant_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  state_row "AccountSecurityState"%ROWTYPE;
  session_row "Session"%ROWTYPE;
  operation_row "GlobalSecurityOperation"%ROWTYPE;
  bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  NEW."expiresAt" := NEW."createdAt" + INTERVAL '10 minutes';
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId" = NEW."userId" FOR UPDATE;
  SELECT * INTO session_row FROM "Session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId" FOR UPDATE;
  IF state_row."userId" IS NULL
    OR state_row."credentialVersion" IS DISTINCT FROM NEW."credentialVersion"
    OR session_row."id" IS NULL
    OR session_row."expiresAt" <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'fresh_auth_grant_session_or_version_invalid';
  END IF;
  IF NEW."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'fresh_auth_grant_initially_expired'; END IF;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF operation_row."bindingId" IS NULL OR operation_row."status" NOT IN ('pending','unknown') OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."sessionId" IS DISTINCT FROM NEW."sessionId" OR bound."securityVersion" IS DISTINCT FROM NEW."credentialVersion" THEN RAISE EXCEPTION 'fresh_auth_grant_operation_binding_mismatch'; END IF;
  IF operation_row."operationKey"::text || '|' || NEW."purpose" NOT IN ('password_change|password_change','recovery_enrollment|recovery_enrollment','email_change|email_change','session_revoke|session_revoke') THEN RAISE EXCEPTION 'fresh_auth_grant_purpose_operation_mismatch'; END IF;
  IF NEW."purpose" IN ('password_change','recovery_enrollment') AND session_user='cubby_runtime' THEN
    IF NOT public."verify_password_fresh_auth_attestation"(NEW."userId",NEW."sessionId",NEW."operationId",NEW."purpose",NEW."credentialVersion",bound."sessionSecurityVersion",bound."openingFingerprint",operation_row."intentFingerprint",NEW."replacementPasswordHashDigest",NEW."attestationNonce",NEW."attestationKeyVersion",NEW."attestationMac") THEN RAISE EXCEPTION 'fresh_auth_attestation_invalid'; END IF;
  ELSIF NEW."purpose"='session_revoke' AND session_user='cubby_runtime' THEN
    IF NOT public."verify_session_revoke_attestation"(NEW."userId",NEW."sessionId",NEW."operationId",NEW."credentialVersion",bound."sessionSecurityVersion",bound."targetSnapshot"->>'scope',bound."targetSnapshot"->>'canonicalTargetHandle',bound."targetSnapshot"->>'resolvedTargetSessionId',bound."openingFingerprint",operation_row."intentFingerprint",NEW."attestationNonce",NEW."attestationKeyVersion",NEW."attestationMac") THEN RAISE EXCEPTION 'fresh_auth_session_revoke_attestation_invalid'; END IF;
  ELSIF NEW."attestationNonce" IS NOT NULL OR NEW."attestationMac" IS NOT NULL OR NEW."attestationKeyVersion" IS NOT NULL OR NEW."replacementPasswordHashDigest" IS NOT NULL THEN RAISE EXCEPTION 'fresh_auth_attestation_invalid';
  END IF;
  IF NEW."credentialVersion" <= 0 OR NEW."state" <> 'issued' OR NEW."consumedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiresAt" <= NEW."createdAt" OR NEW."expiresAt" > NEW."createdAt" + INTERVAL '10 minutes' THEN
    RAISE EXCEPTION 'fresh_auth_grant_initial_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_fresh_auth_grant_issuance_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; session_row "Session"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO session_row FROM "Session" WHERE "id"=NEW."sessionId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id"=NEW."id" FOR UPDATE;
  IF state_row."userId" IS NULL
    OR operation_row."bindingId" IS NULL
    OR bound."userId" IS DISTINCT FROM NEW."userId"
    OR bound."sessionId" IS DISTINCT FROM NEW."sessionId"
    OR bound."operationId" IS DISTINCT FROM NEW."operationId"
    OR bound."operationKey"::text IS DISTINCT FROM NEW."purpose"
    OR bound."securityVersion" IS DISTINCT FROM NEW."credentialVersion"
    OR NOT ((state_row."credentialVersion" = NEW."credentialVersion" AND state_row."sessionSecurityVersion" = bound."sessionSecurityVersion" AND operation_row."status" = 'pending' AND bound."state" = 'submitted' AND session_row."id" IS NOT NULL AND session_row."expiresAt" > clock_timestamp()) OR (operation_row."operationKey" = 'password_change' AND operation_row."status" = 'completed' AND operation_row."outcomeCode" = 'changed' AND bound."state" = 'terminal' AND grant_row."state" = 'consumed' AND state_row."credentialVersion" = bound."securityVersion" + 1 AND state_row."sessionSecurityVersion" = bound."sessionSecurityVersion" + 1) OR (operation_row."operationKey" = 'password_change' AND operation_row."status" = 'stale' AND operation_row."outcomeCode" = 'stale_security_version' AND bound."state" = 'terminal' AND grant_row."state" = 'revoked' AND state_row."credentialVersion" <> bound."securityVersion") OR (operation_row."operationKey" = 'email_change' AND operation_row."status" = 'rejected' AND operation_row."outcomeCode" = 'collision_rejected' AND bound."state" = 'terminal' AND grant_row."state" = 'revoked') OR (operation_row."operationKey" = 'session_revoke' AND operation_row."status" = 'completed' AND operation_row."outcomeCode" IN ('revoked','already_revoked') AND bound."state" = 'terminal' AND grant_row."state" = 'consumed' AND ((bound."targetSnapshot"->>'scope' = 'all' AND state_row."credentialVersion" = bound."securityVersion" AND state_row."sessionSecurityVersion" = bound."sessionSecurityVersion" + 1 AND state_row."lastSessionSecurityOperationId" = NEW."operationId") OR (bound."targetSnapshot"->>'scope' IN ('current','one','others') AND state_row."credentialVersion" = bound."securityVersion" AND state_row."sessionSecurityVersion" = bound."sessionSecurityVersion"))))
  THEN
    RAISE EXCEPTION 'fresh_auth_grant_issuance_finalization_required';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "enforce_fresh_auth_grant_transition"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; session_row "Session"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'fresh_auth_grant_delete_forbidden';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."credentialVersion" IS DISTINCT FROM OLD."credentialVersion" OR NEW."attestationNonce" IS DISTINCT FROM OLD."attestationNonce" OR NEW."attestationMac" IS DISTINCT FROM OLD."attestationMac" OR NEW."attestationKeyVersion" IS DISTINCT FROM OLD."attestationKeyVersion" OR NEW."replacementPasswordHashDigest" IS DISTINCT FROM OLD."replacementPasswordHashDigest" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'fresh_auth_grant_immutable_binding';
  END IF;
  IF OLD."state" <> 'issued' OR NEW."state" NOT IN ('consumed', 'revoked', 'expired') THEN RAISE EXCEPTION 'fresh_auth_grant_invalid_transition'; END IF;
  IF NEW."state" = 'consumed' AND OLD."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'fresh_auth_grant_consumed_after_expiry'; END IF;
  IF NEW."state" = 'consumed' THEN
    SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=OLD."userId" FOR UPDATE;
    SELECT * INTO session_row FROM "Session" WHERE "id"=OLD."sessionId" AND "userId"=OLD."userId" FOR UPDATE;
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=OLD."userId" AND "operationId"=OLD."operationId" FOR UPDATE;
    SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
    IF state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion" THEN RAISE EXCEPTION 'fresh_auth_grant_session_security_version_invalid'; END IF;
    IF operation_row."status" <> 'pending' OR bound."state" <> 'submitted' THEN RAISE EXCEPTION 'fresh_auth_grant_operation_not_consumable'; END IF;
    IF state_row."credentialVersion" IS DISTINCT FROM OLD."credentialVersion" OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() OR bound."userId" IS DISTINCT FROM OLD."userId" OR bound."sessionId" IS DISTINCT FROM OLD."sessionId" OR bound."operationKey"::text IS DISTINCT FROM OLD."purpose" OR bound."securityVersion" IS DISTINCT FROM OLD."credentialVersion" THEN RAISE EXCEPTION 'fresh_auth_grant_current_authorization_required'; END IF;
  END IF;
  IF NEW."state" = 'expired' AND OLD."expiresAt" > clock_timestamp() THEN RAISE EXCEPTION 'fresh_auth_grant_expired_before_deadline'; END IF;
  IF (NEW."state" = 'consumed' AND (NEW."consumedAt" IS NULL OR NEW."revokedAt" IS NOT NULL)) OR (NEW."state" = 'revoked' AND (NEW."revokedAt" IS NULL OR NEW."consumedAt" IS NOT NULL)) OR (NEW."state" = 'expired' AND (NEW."consumedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'fresh_auth_grant_terminal_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_recovery_code_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."setVersion" <= 0 OR NEW."ordinal" NOT BETWEEN 1 AND 10 OR NEW."state" <> 'active' OR NEW."consumedPurpose" IS NOT NULL OR NEW."consumedOperationId" IS NOT NULL OR NEW."consumedAt" IS NOT NULL OR NEW."invalidatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'recovery_code_initial_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_recovery_code_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'recovery_code_delete_forbidden';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."setVersion" IS DISTINCT FROM OLD."setVersion" OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal" OR NEW."salt" IS DISTINCT FROM OLD."salt" OR NEW."derivedKey" IS DISTINCT FROM OLD."derivedKey" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'recovery_code_immutable_binding';
  END IF;
  IF OLD."state" <> 'active' OR NEW."state" NOT IN ('consumed', 'invalidated') THEN RAISE EXCEPTION 'recovery_code_invalid_transition'; END IF;
  IF (NEW."state" = 'consumed' AND (NEW."consumedPurpose" IS NULL OR NEW."consumedOperationId" IS NULL OR NEW."consumedAt" IS NULL OR NEW."invalidatedAt" IS NOT NULL)) OR (NEW."state" = 'invalidated' AND (NEW."invalidatedAt" IS NULL OR NEW."consumedPurpose" IS NOT NULL OR NEW."consumedOperationId" IS NOT NULL OR NEW."consumedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'recovery_code_terminal_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_recovery_session_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" <> 'restricted' OR NEW."consumedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."expiresAt" <= NEW."createdAt" THEN
    RAISE EXCEPTION 'recovery_session_initial_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_recovery_session_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'recovery_session_write_once';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."recoveryCodeId" IS DISTINCT FROM OLD."recoveryCodeId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."attestationNonce" IS DISTINCT FROM OLD."attestationNonce" OR NEW."attestationMac" IS DISTINCT FROM OLD."attestationMac" OR NEW."attestationKeyVersion" IS DISTINCT FROM OLD."attestationKeyVersion" OR NEW."replacementPasswordHashDigest" IS DISTINCT FROM OLD."replacementPasswordHashDigest" OR NEW."attestedOpeningFingerprint" IS DISTINCT FROM OLD."attestedOpeningFingerprint" OR NEW."attestedIntentFingerprint" IS DISTINCT FROM OLD."attestedIntentFingerprint" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'recovery_session_immutable_binding';
  END IF;
  IF OLD."state" <> 'restricted' OR NEW."state" NOT IN ('consumed', 'closed', 'expired') THEN RAISE EXCEPTION 'recovery_session_invalid_transition'; END IF;
  IF NEW."state" IN ('consumed', 'closed') THEN
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=OLD."userId" AND "operationId"=OLD."operationId" FOR UPDATE;
    SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
    IF operation_row."operationKey" <> 'recovery_reset' OR operation_row."status" NOT IN ('completed','rejected','stale') OR bound."id" IS NULL OR bound."userId" IS DISTINCT FROM OLD."userId" OR bound."operationId" IS DISTINCT FROM OLD."operationId" OR bound."operationKey" <> 'recovery_reset' OR bound."recoverySessionId" IS DISTINCT FROM OLD."id" OR bound."sessionId" IS NOT NULL OR bound."state" <> 'terminal' THEN RAISE EXCEPTION 'recovery_session_successful_reset_required'; END IF;
    IF NEW."state" = 'consumed' AND OLD."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'recovery_session_consumed_after_expiry'; END IF;
    IF NEW."state" = 'consumed' AND (operation_row."status" <> 'completed' OR operation_row."outcomeCode" <> 'reset_completed') THEN RAISE EXCEPTION 'recovery_session_successful_reset_required'; END IF;
    IF NEW."state" = 'closed' AND NOT "global_security_terminal_outcome_valid"(operation_row."operationKey", operation_row."status", operation_row."outcomeCode") THEN RAISE EXCEPTION 'recovery_session_successful_reset_required'; END IF;
  ELSE
    IF OLD."expiresAt" > clock_timestamp() THEN RAISE EXCEPTION 'recovery_session_expired_before_deadline'; END IF;
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=OLD."userId" AND "operationId"=OLD."operationId" FOR UPDATE;
    SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
    IF operation_row."operationKey" <> 'recovery_reset' OR operation_row."status" <> 'rejected' OR operation_row."outcomeCode" <> 'recovery_session_expired' OR bound."id" IS NULL OR bound."userId" IS DISTINCT FROM OLD."userId" OR bound."operationId" IS DISTINCT FROM OLD."operationId" OR bound."operationKey" <> 'recovery_reset' OR bound."recoverySessionId" IS DISTINCT FROM OLD."id" OR bound."sessionId" IS NOT NULL OR bound."state" <> 'terminal' THEN RAISE EXCEPTION 'recovery_session_expiry_finalization_required'; END IF;
  END IF;
  IF (NEW."state" = 'consumed' AND (NEW."consumedAt" IS NULL OR NEW."closedAt" IS NOT NULL)) OR (NEW."state" = 'closed' AND (NEW."closedAt" IS NULL OR NEW."consumedAt" IS NOT NULL)) OR (NEW."state" = 'expired' AND (NEW."consumedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'recovery_session_terminal_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "guard_email_change_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; session_row "Session"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF NEW."state" <> 'pending' OR NEW."cancelledAt" IS NOT NULL OR NEW."expiresAt" <= NEW."createdAt" OR NEW."expiresAt" <= clock_timestamp() OR NEW."expiresAt" > NEW."createdAt" + INTERVAL '60 minutes' THEN RAISE EXCEPTION 'email_change_initial_state_invalid'; END IF;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId" = NEW."userId" FOR UPDATE;
  SELECT session.* INTO session_row FROM "FreshAuthGrant" grant_row_source JOIN "Session" session ON session."id" = grant_row_source."sessionId" AND session."userId" = NEW."userId" WHERE grant_row_source."id" = NEW."freshAuthGrantId" FOR UPDATE OF session;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id" = NEW."freshAuthGrantId" FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId" = NEW."userId" AND "operationId" = NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id" = operation_row."bindingId" FOR UPDATE;
  IF NOT FOUND OR state_row."credentialVersion" IS DISTINCT FROM NEW."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM NEW."sessionSecurityVersion" OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() OR grant_row."userId" IS DISTINCT FROM NEW."userId" OR grant_row."operationId" IS DISTINCT FROM NEW."operationId" OR grant_row."purpose" <> 'email_change' OR grant_row."state" <> 'issued' OR grant_row."expiresAt" <= clock_timestamp() OR grant_row."credentialVersion" IS DISTINCT FROM NEW."securityVersion" OR operation_row."operationKey" <> 'email_change' OR operation_row."status" NOT IN ('pending', 'unknown') OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."operationId" IS DISTINCT FROM NEW."operationId" OR bound."operationKey" <> 'email_change' OR bound."securityVersion" IS DISTINCT FROM NEW."securityVersion" OR bound."sessionSecurityVersion" IS DISTINCT FROM NEW."sessionSecurityVersion" OR bound."sessionId" IS DISTINCT FROM grant_row."sessionId" OR bound."state" <> 'submitted' THEN
    RAISE EXCEPTION 'email_change_fresh_grant_operation_mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_email_change_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'email_change_delete_forbidden';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."freshAuthGrantId" IS DISTINCT FROM OLD."freshAuthGrantId" OR NEW."securityVersion" IS DISTINCT FROM OLD."securityVersion" OR NEW."normalizedNewEmail" IS DISTINCT FROM OLD."normalizedNewEmail" OR NEW."verificationDigest" IS DISTINCT FROM OLD."verificationDigest" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'email_change_immutable_binding';
  END IF;
  IF NOT ((OLD."state" = 'pending' AND NEW."state" IN ('verified', 'cancelled', 'expired', 'abandoned', 'failed')) OR (OLD."state" = 'verified' AND NEW."state" = 'completed')) THEN
    RAISE EXCEPTION 'email_change_invalid_transition';
  END IF;
  IF (NEW."state" = 'cancelled' AND NEW."cancelledAt" IS NOT NULL) OR (NEW."state" <> 'cancelled' AND NEW."cancelledAt" IS NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'email_change_terminal_state_invalid';
END $$;

CREATE FUNCTION "prevent_global_security_retention_delete"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'global_security_retention_delete_forbidden';
END $$;

DROP TRIGGER "AccountSecurityState_version_guard" ON "AccountSecurityState";
CREATE TRIGGER "AccountSecurityState_version_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountSecurityState" FOR EACH ROW EXECUTE FUNCTION "enforce_account_security_version_transition"();
DROP TRIGGER "FreshAuthGrant_state_guard" ON "FreshAuthGrant";
CREATE TRIGGER "FreshAuthGrant_initial_state_guard" BEFORE INSERT ON "FreshAuthGrant" FOR EACH ROW EXECUTE FUNCTION "enforce_fresh_auth_grant_initial_state"();
CREATE TRIGGER "FreshAuthGrant_state_guard" BEFORE UPDATE OR DELETE ON "FreshAuthGrant" FOR EACH ROW EXECUTE FUNCTION "enforce_fresh_auth_grant_transition"();
CREATE CONSTRAINT TRIGGER "FreshAuthGrant_issuance_guard" AFTER INSERT ON "FreshAuthGrant" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_fresh_auth_grant_issuance_finalization"();
DROP TRIGGER "RecoveryCode_single_consume" ON "RecoveryCode";
CREATE TRIGGER "RecoveryCode_initial_state_guard" BEFORE INSERT ON "RecoveryCode" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_initial_state"();
CREATE TRIGGER "RecoveryCode_single_consume" BEFORE UPDATE OR DELETE ON "RecoveryCode" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_transition"();
DROP TRIGGER "RecoverySession_state_guard" ON "RecoverySession";
CREATE TRIGGER "RecoverySession_initial_state_guard" BEFORE INSERT ON "RecoverySession" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_session_initial_state"();
CREATE TRIGGER "RecoverySession_state_guard" BEFORE UPDATE OR DELETE ON "RecoverySession" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_session_transition"();
DROP TRIGGER "EmailChange_state_guard" ON "EmailChange";
CREATE TRIGGER "EmailChange_initial_state_guard" BEFORE INSERT ON "EmailChange" FOR EACH ROW EXECUTE FUNCTION "guard_email_change_initial_state"();
CREATE TRIGGER "EmailChange_state_guard" BEFORE UPDATE OR DELETE ON "EmailChange" FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_transition"();
CREATE FUNCTION "enforce_global_security_incident_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE;
BEGIN
  IF (NEW."layer"='account_identifier' AND NEW."userId" IS NULL) OR (NEW."layer" IN ('client','deployment') AND NEW."userId" IS NOT NULL) THEN RAISE EXCEPTION 'global_security_incident_layer_owner_invalid'; END IF;
  IF NEW."userId" IS NOT NULL THEN
    SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
    IF state_row."userId" IS NULL THEN RAISE EXCEPTION 'global_security_incident_user_state_missing'; END IF;
  END IF;
  IF NEW."layer" NOT IN ('account_identifier','client','deployment') OR length(NEW."normalizedKey")=0 OR NEW."failureCount" < 1 OR NEW."state" <> 'active' OR NEW."quietUntil" IS NOT NULL OR NEW."windowStartedAt" > NEW."lastOutcomeAt" OR NEW."lastOutcomeAt" > clock_timestamp() + INTERVAL '1 millisecond' OR NEW."createdAt" > clock_timestamp() + INTERVAL '1 millisecond' THEN
    RAISE EXCEPTION 'global_security_incident_initial_state_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION "enforce_global_security_incident_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."layer" IS DISTINCT FROM OLD."layer" OR NEW."normalizedKey" IS DISTINCT FROM OLD."normalizedKey" OR NEW."windowStartedAt" IS DISTINCT FROM OLD."windowStartedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'global_security_incident_identity_immutable'; END IF;
  IF NEW."failureCount" < OLD."failureCount" THEN RAISE EXCEPTION 'global_security_incident_counter_regression'; END IF;
  IF NEW."lastOutcomeAt" < OLD."lastOutcomeAt" OR NEW."lastOutcomeAt" > clock_timestamp() + INTERVAL '1 millisecond' THEN RAISE EXCEPTION 'global_security_incident_time_invalid'; END IF;
  IF OLD."quietUntil" IS NOT NULL AND (NEW."quietUntil" IS NULL OR NEW."quietUntil" < OLD."quietUntil") THEN RAISE EXCEPTION 'global_security_incident_quiet_period_regression'; END IF;
  IF (NEW."state"='active' AND NEW."quietUntil" IS NOT NULL) OR (NEW."state"='quiet' AND (NEW."quietUntil" IS NULL OR NEW."quietUntil" < NEW."lastOutcomeAt")) THEN RAISE EXCEPTION 'global_security_incident_quiet_period_invalid'; END IF;
  IF NOT ((OLD."state"='active' AND NEW."state" IN ('active','quiet','closed')) OR (OLD."state"='quiet' AND NEW."state" IN ('quiet','closed')) OR (OLD."state"='closed' AND NEW."state"='closed' AND NEW."failureCount"=OLD."failureCount" AND NEW."lastOutcomeAt"=OLD."lastOutcomeAt" AND NEW."quietUntil" IS NOT DISTINCT FROM OLD."quietUntil")) THEN RAISE EXCEPTION 'global_security_incident_transition_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GlobalSecurityIncident_initial_state_guard" BEFORE INSERT ON "GlobalSecurityIncident" FOR EACH ROW EXECUTE FUNCTION "enforce_global_security_incident_initial_state"();
CREATE TRIGGER "GlobalSecurityIncident_state_guard" BEFORE UPDATE ON "GlobalSecurityIncident" FOR EACH ROW EXECUTE FUNCTION "enforce_global_security_incident_transition"();
CREATE TRIGGER "GlobalSecurityIncident_retention_guard" BEFORE DELETE ON "GlobalSecurityIncident" FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_retention_delete"();
CREATE TRIGGER "RecoveryCodeSet_retention_guard" BEFORE DELETE ON "RecoveryCodeSet" FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_retention_delete"();
CREATE TRIGGER "SessionSecurityActivity_retention_guard" BEFORE DELETE ON "SessionSecurityActivity" FOR EACH ROW EXECUTE FUNCTION "prevent_global_security_retention_delete"();

-- Only a foreign-key cascade from User deletion may remove retained evidence.
CREATE OR REPLACE FUNCTION "prevent_global_security_retention_delete"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'global_security_retention_delete_forbidden';
END $$;
CREATE OR REPLACE FUNCTION "prevent_global_security_event_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'global_security_event_append_only';
END $$;
CREATE OR REPLACE FUNCTION "prevent_global_security_tombstone_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'global_security_tombstone_write_once';
END $$;
CREATE OR REPLACE FUNCTION "guard_global_security_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  PERFORM "lock_global_security_operation_identity_v1"(NEW."userId", NEW."operationId");
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF NOT FOUND OR bound."state"<>'terminal' OR operation_row."operationKey" IS DISTINCT FROM NEW."operationKey" OR operation_row."intentFingerprint" IS DISTINCT FROM NEW."intentFingerprint" OR operation_row."status" NOT IN ('completed','rejected','stale') OR NEW."terminalStatus" IS DISTINCT FROM operation_row."status" OR operation_row."outcomeCode" IS DISTINCT FROM NEW."terminalCode" OR operation_row."terminalAt" IS DISTINCT FROM NEW."terminalAt" THEN RAISE EXCEPTION 'GlobalSecurityOperationTombstone_terminal_status_mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION "enforce_recovery_session_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE code_row "RecoveryCode"%ROWTYPE;
BEGIN
  SELECT * INTO code_row FROM "RecoveryCode" WHERE "id"=NEW."recoveryCodeId" AND "userId"=NEW."userId" FOR UPDATE;
  IF NOT FOUND OR code_row."state" <> 'consumed' THEN RAISE EXCEPTION 'recovery_session_recovery_code_not_consumed'; END IF;
  IF NEW."expiresAt" IS DISTINCT FROM NEW."createdAt" + INTERVAL '10 minutes' THEN RAISE EXCEPTION 'recovery_session_ttl_invalid'; END IF;
  IF NEW."purpose" <> 'recovery_reset' OR NEW."state" <> 'restricted' OR NEW."consumedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN RAISE EXCEPTION 'recovery_session_initial_state_invalid'; END IF;
  IF NEW."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'recovery_session_initially_expired'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION "enforce_recovery_code_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  IF state_row."userId" IS NULL THEN RAISE EXCEPTION 'recovery_code_security_state_missing'; END IF;
  IF NEW."setVersion"<=0 OR NEW."ordinal" NOT BETWEEN 1 AND 10 OR NEW."state"<>'active' OR NEW."consumedPurpose" IS NOT NULL OR NEW."consumedOperationId" IS NOT NULL OR NEW."consumedAt" IS NOT NULL OR NEW."invalidatedAt" IS NOT NULL THEN RAISE EXCEPTION 'recovery_code_initial_state_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION "enforce_session_security_activity_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE session_row "Session"%ROWTYPE; state_row "AccountSecurityState"%ROWTYPE; change_row "EmailChange"%ROWTYPE; binding_row "GlobalSecurityOperationBinding"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; old_activity "SessionSecurityActivity"%ROWTYPE;
BEGIN
  SELECT * INTO session_row FROM "Session" WHERE "id"=NEW."sessionId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  IF session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'session_security_activity_session_mismatch';
  END IF;
  IF state_row."userId" IS NULL THEN RAISE EXCEPTION 'session_security_activity_issuance_version_invalid'; END IF;
  IF NEW."issuanceSessionSecurityVersion" IS DISTINCT FROM state_row."sessionSecurityVersion" THEN
    SELECT * INTO change_row FROM "EmailChange" WHERE "userId"=NEW."userId" AND "sessionSecurityVersion"+1=NEW."issuanceSessionSecurityVersion" FOR UPDATE;
    SELECT * INTO binding_row FROM "GlobalSecurityOperationBinding" WHERE "userId"=NEW."userId" AND "operationId"=change_row."operationId" FOR UPDATE;
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=change_row."operationId" FOR UPDATE;
    SELECT * INTO old_activity FROM "SessionSecurityActivity" WHERE "sessionId"=binding_row."sessionId" AND "userId"=NEW."userId" FOR UPDATE;
    IF current_user=session_user OR change_row."id" IS NULL OR NEW."issuanceSessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion"+1 OR change_row."state" NOT IN ('verified','completed') OR state_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion"
      OR binding_row."id" IS NULL OR binding_row."operationKey" IS DISTINCT FROM 'email_change' OR binding_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion" OR binding_row."state" IS DISTINCT FROM 'submitted'
      OR operation_row."operationId" IS NULL OR operation_row."bindingId" IS DISTINCT FROM binding_row."id" OR operation_row."operationKey" IS DISTINCT FROM 'email_change' OR operation_row."status" IS DISTINCT FROM 'pending'
      OR old_activity."sessionId" IS NULL OR NEW."originalCreatedAt" IS DISTINCT FROM old_activity."originalCreatedAt"
    THEN RAISE EXCEPTION 'session_security_activity_issuance_version_invalid'; END IF;
  ELSIF NEW."originalCreatedAt" IS DISTINCT FROM session_row."createdAt" THEN
    RAISE EXCEPTION 'session_security_activity_session_mismatch';
  END IF;
  IF NEW."lastQualifyingAt" < NEW."originalCreatedAt" OR NEW."lastQualifyingAt" > clock_timestamp() + INTERVAL '1 millisecond' THEN
    RAISE EXCEPTION 'session_security_activity_qualifying_time_invalid';
  END IF;
  IF NEW."warningAt" IS NOT NULL THEN RAISE EXCEPTION 'session_security_activity_warning_invalid'; END IF;
  IF NEW."state" <> 'active' THEN RAISE EXCEPTION 'session_security_activity_transition_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION "enforce_session_security_activity_write_once"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'global_security_retention_delete_forbidden'; END IF;
  IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."issuanceSessionSecurityVersion" IS DISTINCT FROM OLD."issuanceSessionSecurityVersion" OR NEW."originalCreatedAt" IS DISTINCT FROM OLD."originalCreatedAt" THEN RAISE EXCEPTION 'session_security_activity_immutable_binding'; END IF;
  IF NEW."lastQualifyingAt" < OLD."lastQualifyingAt" OR NEW."lastQualifyingAt" < NEW."originalCreatedAt" OR NEW."lastQualifyingAt" > clock_timestamp() + INTERVAL '1 millisecond' THEN RAISE EXCEPTION 'session_security_activity_qualifying_time_invalid'; END IF;
  IF (OLD."warningAt" IS NOT NULL AND NEW."warningAt" IS DISTINCT FROM OLD."warningAt") OR (NEW."warningAt" IS NOT NULL AND (NEW."warningAt" < NEW."originalCreatedAt" OR NEW."warningAt" > clock_timestamp() + INTERVAL '1 millisecond')) THEN RAISE EXCEPTION 'session_security_activity_warning_invalid'; END IF;
  IF NOT ((OLD."state"='active' AND NEW."state" IN ('active','expired','revoked')) OR (OLD."state" IN ('expired','revoked') AND NEW."state"=OLD."state" AND NEW."lastQualifyingAt"=OLD."lastQualifyingAt" AND NEW."warningAt" IS NOT DISTINCT FROM OLD."warningAt")) THEN RAISE EXCEPTION 'session_security_activity_transition_invalid'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "SessionSecurityActivity_retention_guard" ON "SessionSecurityActivity";
CREATE TRIGGER "SessionSecurityActivity_initial_state_guard" BEFORE INSERT ON "SessionSecurityActivity" FOR EACH ROW EXECUTE FUNCTION "enforce_session_security_activity_initial_state"();
CREATE TRIGGER "SessionSecurityActivity_write_once" BEFORE UPDATE OR DELETE ON "SessionSecurityActivity" FOR EACH ROW EXECUTE FUNCTION "enforce_session_security_activity_write_once"();
CREATE FUNCTION "prevent_global_security_retention_truncate"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'global_security_retention_truncate_forbidden'; END $$;
CREATE TRIGGER "AccountSecurityState_retention_truncate_guard" BEFORE TRUNCATE ON "AccountSecurityState" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "FreshAuthGrant_retention_truncate_guard" BEFORE TRUNCATE ON "FreshAuthGrant" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "RecoveryCode_retention_truncate_guard" BEFORE TRUNCATE ON "RecoveryCode" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "RecoveryCodeSet_retention_truncate_guard" BEFORE TRUNCATE ON "RecoveryCodeSet" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();

CREATE FUNCTION "enforce_recovery_code_set_exact_ten"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_count INTEGER; actual_count INTEGER; scope_user_id TEXT; scope_set_version INTEGER;
BEGIN
  IF TG_OP='DELETE' THEN scope_user_id:=OLD."userId"; scope_set_version:=OLD."setVersion"; ELSE scope_user_id:=NEW."userId"; scope_set_version:=NEW."setVersion"; END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=scope_user_id) THEN RETURN NULL; END IF;
  SELECT "expectedCodeCount" INTO expected_count FROM "RecoveryCodeSet" WHERE "userId"=scope_user_id AND "setVersion"=scope_set_version;
  IF expected_count IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*) INTO actual_count FROM "RecoveryCode" WHERE "userId"=scope_user_id AND "setVersion"=scope_set_version;
  IF expected_count <> 10 OR actual_count <> 10 THEN RAISE EXCEPTION 'recovery_code_set_exact_ten_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "RecoveryCodeSet_exact_ten_guard" AFTER INSERT OR UPDATE OR DELETE ON "RecoveryCodeSet" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_set_exact_ten"();
CREATE CONSTRAINT TRIGGER "RecoveryCode_exact_ten_guard" AFTER INSERT OR UPDATE OR DELETE ON "RecoveryCode" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_set_exact_ten"();

CREATE OR REPLACE FUNCTION "enforce_recovery_code_set_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE; session_row "Session"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; prior_version INTEGER;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id"=NEW."freshAuthGrantId" FOR UPDATE;
  SELECT * INTO session_row FROM "Session" WHERE "id"=grant_row."sessionId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."issuanceOperationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF state_row."userId" IS NULL OR grant_row."userId" IS DISTINCT FROM NEW."userId" OR grant_row."operationId" IS DISTINCT FROM NEW."issuanceOperationId" OR grant_row."purpose" <> 'recovery_enrollment' OR grant_row."state" <> 'issued' OR grant_row."expiresAt" <= clock_timestamp() OR grant_row."credentialVersion" IS DISTINCT FROM NEW."issuanceSecurityVersion" OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() OR operation_row."operationKey" <> 'recovery_enrollment' OR operation_row."status" NOT IN ('pending','unknown') OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."sessionId" IS DISTINCT FROM grant_row."sessionId" OR bound."recoverySessionId" IS NOT NULL OR bound."operationId" IS DISTINCT FROM NEW."issuanceOperationId" OR bound."operationKey" <> 'recovery_enrollment' OR bound."securityVersion" IS DISTINCT FROM NEW."issuanceSecurityVersion" OR bound."sessionSecurityVersion" IS DISTINCT FROM NEW."issuanceSessionSecurityVersion" OR bound."state" <> 'submitted' OR state_row."credentialVersion" IS DISTINCT FROM NEW."issuanceSecurityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM NEW."issuanceSessionSecurityVersion" THEN
    RAISE EXCEPTION 'recovery_code_set_issuance_authorization_required';
  END IF;
  SELECT max("setVersion") INTO prior_version FROM "RecoveryCodeSet" WHERE "userId"=NEW."userId";
  IF NEW."expectedCodeCount" <> 10 OR NEW."state" <> 'generated' OR NEW."saveAcknowledgedAt" IS NOT NULL OR NEW."rehearsedAt" IS NOT NULL OR NEW."setVersion" <> COALESCE(prior_version + 1, 1) THEN RAISE EXCEPTION 'recovery_code_set_initial_state_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM "RecoveryCodeSet" WHERE "userId"=NEW."userId" AND "state" <> 'invalidated') THEN RAISE EXCEPTION 'recovery_code_set_live_set_exists'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "assert_recovery_code_set_issuance_authorization"(scope_user_id TEXT, scope_operation_id TEXT, grant_id TEXT, expected_credential_version INTEGER, expected_session_security_version INTEGER, expected_grant_state "FreshAuthGrantState")
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE; session_row "Session"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id"=grant_id FOR UPDATE;
  SELECT * INTO session_row FROM "Session" WHERE "id"=grant_row."sessionId" AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF state_row."userId" IS NULL OR state_row."credentialVersion" IS DISTINCT FROM expected_credential_version OR state_row."sessionSecurityVersion" IS DISTINCT FROM expected_session_security_version OR grant_row."userId" IS DISTINCT FROM scope_user_id OR grant_row."operationId" IS DISTINCT FROM scope_operation_id OR grant_row."purpose" <> 'recovery_enrollment' OR grant_row."state" IS DISTINCT FROM expected_grant_state OR grant_row."consumedAt" IS NULL OR grant_row."expiresAt" <= clock_timestamp() OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() OR operation_row."operationKey" IS DISTINCT FROM 'recovery_enrollment' OR operation_row."status" NOT IN ('pending','unknown') OR bound."userId" IS DISTINCT FROM scope_user_id OR bound."operationId" IS DISTINCT FROM scope_operation_id OR bound."operationKey" IS DISTINCT FROM 'recovery_enrollment' OR bound."sessionId" IS DISTINCT FROM grant_row."sessionId" OR bound."recoverySessionId" IS NOT NULL OR bound."securityVersion" IS DISTINCT FROM expected_credential_version OR bound."sessionSecurityVersion" IS DISTINCT FROM expected_session_security_version OR bound."state" IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'recovery_code_set_issuance_authorization_required'; END IF;
END $$;

CREATE FUNCTION "enforce_recovery_code_set_issuance_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "assert_recovery_code_set_issuance_authorization"(NEW."userId", NEW."issuanceOperationId", NEW."freshAuthGrantId", NEW."issuanceSecurityVersion", NEW."issuanceSessionSecurityVersion", 'consumed'::"FreshAuthGrantState");
  RETURN NULL;
END $$;

CREATE FUNCTION "enforce_recovery_code_consumption_binding"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; session_row "Session"%ROWTYPE; recovery_session_row "RecoverySession"%ROWTYPE;
BEGIN
  IF NEW."state" <> 'consumed' THEN RETURN NULL; END IF;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."consumedOperationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF operation_row."userId" IS DISTINCT FROM NEW."userId" OR NOT ((operation_row."status" IN ('pending','unknown') AND bound."state"='submitted') OR (operation_row."status"='completed' AND operation_row."outcomeCode" IN ('rehearsal_completed','reset_completed') AND bound."state"='terminal')) OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."operationId" IS DISTINCT FROM NEW."consumedOperationId" THEN RAISE EXCEPTION 'recovery_code_consumption_binding_mismatch'; END IF;
  IF NEW."consumedPurpose"='enrollment_rehearsal' THEN
    SELECT * INTO session_row FROM "Session" WHERE "id"=bound."sessionId" AND "userId"=NEW."userId" FOR UPDATE;
    IF operation_row."operationKey" IS DISTINCT FROM 'recovery_enrollment' OR bound."operationKey" IS DISTINCT FROM 'recovery_enrollment' OR bound."sessionId" IS NULL OR bound."recoverySessionId" IS NOT NULL OR bound."expiresAt" <= clock_timestamp() OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'recovery_code_consumption_binding_mismatch'; END IF;
  ELSIF NEW."consumedPurpose"='recovery_reset' THEN
    SELECT * INTO recovery_session_row FROM "RecoverySession" WHERE "id"=bound."recoverySessionId" AND "userId"=NEW."userId" FOR UPDATE;
    IF operation_row."operationKey" IS DISTINCT FROM 'recovery_reset' OR bound."operationKey" IS DISTINCT FROM 'recovery_reset' OR bound."sessionId" IS NOT NULL OR recovery_session_row."id" IS NULL OR recovery_session_row."recoveryCodeId" IS DISTINCT FROM NEW."id" OR recovery_session_row."operationId" IS DISTINCT FROM NEW."consumedOperationId" OR recovery_session_row."purpose" IS DISTINCT FROM 'recovery_reset' OR NOT (recovery_session_row."state"='restricted' OR (recovery_session_row."state"='closed' AND operation_row."status"='completed' AND operation_row."outcomeCode"='reset_completed')) OR (recovery_session_row."state"='restricted' AND recovery_session_row."expiresAt" <= clock_timestamp()) THEN RAISE EXCEPTION 'recovery_code_consumption_binding_mismatch'; END IF;
  ELSE
    RAISE EXCEPTION 'recovery_code_consumption_binding_mismatch';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "enforce_recovery_code_set_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE active_count INTEGER; rehearsal_count INTEGER;
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'recovery_code_set_delete_forbidden';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."setVersion" IS DISTINCT FROM OLD."setVersion" OR NEW."issuanceOperationId" IS DISTINCT FROM OLD."issuanceOperationId" OR NEW."freshAuthGrantId" IS DISTINCT FROM OLD."freshAuthGrantId" OR NEW."issuanceSecurityVersion" IS DISTINCT FROM OLD."issuanceSecurityVersion" OR NEW."issuanceSessionSecurityVersion" IS DISTINCT FROM OLD."issuanceSessionSecurityVersion" OR NEW."expectedCodeCount" IS DISTINCT FROM OLD."expectedCodeCount" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'recovery_code_set_immutable_binding'; END IF;
  IF NOT ((OLD."state"='generated' AND NEW."state" IN ('save_acknowledged','invalidated')) OR (OLD."state"='save_acknowledged' AND NEW."state" IN ('rehearsal_required','invalidated')) OR (OLD."state"='rehearsal_required' AND NEW."state" IN ('rehearsed','invalidated')) OR (OLD."state"='rehearsed' AND NEW."state"='invalidated')) THEN RAISE EXCEPTION 'recovery_code_set_invalid_transition'; END IF;
  IF NEW."state"='invalidated' AND EXISTS (SELECT 1 FROM "RecoveryCode" code JOIN "RecoverySession" session ON session."userId"=code."userId" AND session."recoveryCodeId"=code."id" WHERE code."userId"=NEW."userId" AND code."setVersion"=NEW."setVersion" AND session."state"='restricted') THEN RAISE EXCEPTION 'recovery_code_set_restricted_carrier_closure_required'; END IF;
  IF NEW."state" IN ('save_acknowledged','rehearsal_required','rehearsed') AND NEW."saveAcknowledgedAt" IS NULL THEN RAISE EXCEPTION 'recovery_code_set_save_acknowledgement_required'; END IF;
  IF NEW."state"='rehearsed' THEN
    SELECT count(*) FILTER (WHERE "state"='active'), count(*) FILTER (WHERE "state"='consumed' AND "consumedPurpose"='enrollment_rehearsal') INTO active_count, rehearsal_count FROM "RecoveryCode" WHERE "userId"=NEW."userId" AND "setVersion"=NEW."setVersion";
    IF NEW."rehearsedAt" IS NULL OR active_count <> 9 OR rehearsal_count <> 1 THEN RAISE EXCEPTION 'recovery_code_set_rehearsal_required'; END IF;
  ELSIF NEW."rehearsedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'recovery_code_set_rehearsal_state_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_recovery_code_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE set_row "RecoveryCodeSet"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'recovery_code_delete_forbidden'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."setVersion" IS DISTINCT FROM OLD."setVersion" OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal" OR NEW."salt" IS DISTINCT FROM OLD."salt" OR NEW."derivedKey" IS DISTINCT FROM OLD."derivedKey" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'recovery_code_immutable_binding'; END IF;
  IF OLD."state" <> 'active' OR NEW."state" NOT IN ('consumed','invalidated') THEN RAISE EXCEPTION 'recovery_code_invalid_transition'; END IF;
  IF (NEW."state"='consumed' AND (NEW."consumedPurpose" IS NULL OR NEW."consumedOperationId" IS NULL OR NEW."consumedAt" IS NULL OR NEW."invalidatedAt" IS NOT NULL)) OR (NEW."state"='invalidated' AND (NEW."invalidatedAt" IS NULL OR NEW."consumedPurpose" IS NOT NULL OR NEW."consumedOperationId" IS NOT NULL OR NEW."consumedAt" IS NOT NULL)) THEN RAISE EXCEPTION 'recovery_code_terminal_state_invalid'; END IF;
  IF NEW."state"='consumed' THEN
    SELECT * INTO set_row FROM "RecoveryCodeSet" WHERE "userId"=NEW."userId" AND "setVersion"=NEW."setVersion" FOR UPDATE;
    SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."consumedOperationId" FOR UPDATE;
    IF NEW."consumedPurpose"='enrollment_rehearsal' AND (set_row."state" <> 'rehearsal_required' OR operation_row."operationKey" <> 'recovery_enrollment') THEN RAISE EXCEPTION 'recovery_code_consumption_operation_mismatch'; END IF;
    IF NEW."consumedPurpose"='recovery_reset' AND set_row."state" <> 'rehearsed' THEN RAISE EXCEPTION 'recovery_code_consumption_operation_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "verify_recovery_reset_attestation"(scope_user_id TEXT, scope_code_id TEXT, scope_set_version INTEGER, scope_operation_id TEXT, scope_credential_version INTEGER, scope_session_security_version INTEGER, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT, scope_replacement_digest BYTEA, scope_nonce TEXT, scope_key_version INTEGER, scope_mac BYTEA)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE key_row public."FreshAuthAttestationKey"%ROWTYPE; payload TEXT;
BEGIN
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_key_version AND "active"=true AND ("rotatedAt" IS NULL OR "rotatedAt">clock_timestamp()-INTERVAL '10 minutes');
  IF key_row."keyVersion" IS NULL OR scope_replacement_digest IS NULL OR octet_length(scope_replacement_digest)<>32 OR scope_nonce !~ '^[A-Za-z0-9_-]{43}$' OR scope_mac IS NULL OR octet_length(scope_mac)<>32 THEN RETURN false; END IF;
  payload := concat_ws('|','recovery-reset-attestation-v1',encode(convert_to(scope_user_id,'UTF8'),'hex'),encode(convert_to(scope_code_id,'UTF8'),'hex'),scope_set_version::text,encode(convert_to(scope_operation_id,'UTF8'),'hex'),scope_credential_version::text,scope_session_security_version::text,encode(convert_to(scope_opening_fingerprint,'UTF8'),'hex'),encode(convert_to(scope_intent_fingerprint,'UTF8'),'hex'),encode(scope_replacement_digest,'hex'),encode(convert_to(scope_nonce,'UTF8'),'hex'),scope_key_version::text);
  RETURN public.hmac(convert_to(payload,'UTF8'),key_row."verificationKey",'sha256')=scope_mac;
END $$;
REVOKE ALL ON FUNCTION "verify_recovery_reset_attestation"(TEXT,TEXT,INTEGER,TEXT,INTEGER,INTEGER,TEXT,TEXT,BYTEA,TEXT,INTEGER,BYTEA) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "enforce_recovery_session_initial_state"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE code_row "RecoveryCode"%ROWTYPE; set_row "RecoveryCodeSet"%ROWTYPE; state_row "AccountSecurityState"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  NEW."expiresAt" := NEW."createdAt" + INTERVAL '10 minutes';
  SELECT * INTO code_row FROM "RecoveryCode" WHERE "id"=NEW."recoveryCodeId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO set_row FROM "RecoveryCodeSet" WHERE "userId"=code_row."userId" AND "setVersion"=code_row."setVersion" FOR UPDATE;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  IF NOT FOUND OR code_row."state" <> 'active' THEN RAISE EXCEPTION 'recovery_session_active_recovery_code_required'; END IF;
  IF set_row."state" <> 'rehearsed' THEN RAISE EXCEPTION 'recovery_session_rehearsed_set_required'; END IF;
  IF code_row."consumedPurpose" IS NOT NULL OR code_row."consumedOperationId" IS NOT NULL OR code_row."consumedAt" IS NOT NULL THEN RAISE EXCEPTION 'recovery_session_active_recovery_code_required'; END IF;
  IF NEW."expiresAt" IS DISTINCT FROM NEW."createdAt" + INTERVAL '10 minutes' THEN RAISE EXCEPTION 'recovery_session_ttl_invalid'; END IF;
  IF NEW."purpose" <> 'recovery_reset' OR NEW."state" <> 'restricted' OR NEW."consumedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'recovery_session_initial_state_invalid'; END IF;
  IF session_user='cubby_runtime' AND NOT public."verify_recovery_reset_attestation"(NEW."userId",NEW."recoveryCodeId",code_row."setVersion",NEW."operationId",state_row."credentialVersion",state_row."sessionSecurityVersion",NEW."attestedOpeningFingerprint",NEW."attestedIntentFingerprint",NEW."replacementPasswordHashDigest",NEW."attestationNonce",NEW."attestationKeyVersion",NEW."attestationMac") THEN RAISE EXCEPTION 'recovery_reset_attestation_invalid'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "enforce_recovery_session_consumption_binding"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; code_row "RecoveryCode"%ROWTYPE;
BEGIN
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  SELECT * INTO code_row FROM "RecoveryCode" WHERE "id"=NEW."recoveryCodeId" AND "userId"=NEW."userId" FOR UPDATE;
  IF operation_row."operationKey" <> 'recovery_reset' OR (operation_row."status" NOT IN ('pending','unknown') AND NOT (operation_row."status"='completed' AND operation_row."outcomeCode"='reset_completed')) OR bound."userId" IS DISTINCT FROM NEW."userId" OR bound."operationId" IS DISTINCT FROM NEW."operationId" OR bound."operationKey" <> 'recovery_reset' OR bound."recoverySessionId" IS DISTINCT FROM NEW."id" OR bound."sessionId" IS NOT NULL OR code_row."state" <> 'consumed' OR code_row."consumedPurpose" <> 'recovery_reset' OR code_row."consumedOperationId" IS DISTINCT FROM NEW."operationId" THEN RAISE EXCEPTION 'recovery_session_consumption_binding_mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "RecoveryCodeSet_initial_state_guard" BEFORE INSERT ON "RecoveryCodeSet" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_set_initial_state"();
CREATE TRIGGER "RecoveryCodeSet_state_guard" BEFORE UPDATE OR DELETE ON "RecoveryCodeSet" FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_set_transition"();
CREATE CONSTRAINT TRIGGER "RecoveryCodeSet_issuance_guard" AFTER INSERT ON "RecoveryCodeSet" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_set_issuance_finalization"();
CREATE CONSTRAINT TRIGGER "RecoveryCode_consumption_guard" AFTER UPDATE ON "RecoveryCode" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_code_consumption_binding"();
CREATE CONSTRAINT TRIGGER "RecoverySession_consumption_binding_guard" AFTER INSERT ON "RecoverySession" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_session_consumption_binding"();
CREATE TRIGGER "RecoverySession_retention_truncate_guard" BEFORE TRUNCATE ON "RecoverySession" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityOperationBinding_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityOperationBinding" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityOperation_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityOperation" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityOperationTombstone_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityOperationTombstone" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityOperationReservationTombstone_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityOperationReservationTombstone" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityEvent_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityEvent" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "GlobalSecurityIncident_retention_truncate_guard" BEFORE TRUNCATE ON "GlobalSecurityIncident" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "EmailChange_retention_truncate_guard" BEFORE TRUNCATE ON "EmailChange" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE TRIGGER "SessionSecurityActivity_retention_truncate_guard" BEFORE TRUNCATE ON "SessionSecurityActivity" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();

CREATE FUNCTION "assert_email_change_current_authorization"(scope_user_id TEXT, scope_operation_id TEXT, grant_id TEXT, expected_version INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  state_row "AccountSecurityState"%ROWTYPE;
  session_row "Session"%ROWTYPE;
  grant_row "FreshAuthGrant"%ROWTYPE;
  operation_row "GlobalSecurityOperation"%ROWTYPE;
  bound "GlobalSecurityOperationBinding"%ROWTYPE;
  expected_session_id TEXT;
BEGIN
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT "sessionId" INTO expected_session_id FROM "FreshAuthGrant" WHERE "id"=grant_id;
  SELECT * INTO session_row FROM "Session" WHERE "id"=expected_session_id AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id"=grant_id FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF state_row."userId" IS NULL
    OR state_row."credentialVersion" IS DISTINCT FROM expected_version
    OR state_row."sessionSecurityVersion" IS DISTINCT FROM bound."sessionSecurityVersion"
    OR session_row."id" IS NULL
    OR session_row."userId" IS DISTINCT FROM scope_user_id
    OR session_row."expiresAt" <= clock_timestamp()
    OR grant_row."id" IS NULL
    OR grant_row."userId" IS DISTINCT FROM scope_user_id
    OR grant_row."operationId" IS DISTINCT FROM scope_operation_id
    OR grant_row."purpose" <> 'email_change'
    OR grant_row."state" NOT IN ('issued', 'expired')
    OR grant_row."consumedAt" IS NOT NULL
    OR grant_row."revokedAt" IS NOT NULL
    OR grant_row."credentialVersion" IS DISTINCT FROM expected_version
    OR operation_row."bindingId" IS NULL
    OR operation_row."operationKey" <> 'email_change'
    OR operation_row."status" NOT IN ('pending', 'unknown')
    OR bound."id" IS NULL
    OR bound."userId" IS DISTINCT FROM scope_user_id
    OR bound."operationId" IS DISTINCT FROM scope_operation_id
    OR bound."operationKey" <> 'email_change'
    OR bound."securityVersion" IS DISTINCT FROM expected_version
    OR bound."sessionId" IS DISTINCT FROM grant_row."sessionId"
    OR bound."state" <> 'submitted'
  THEN
    RAISE EXCEPTION 'email_change_current_authorization_required';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION "enforce_email_change_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'email_change_delete_forbidden'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."freshAuthGrantId" IS DISTINCT FROM OLD."freshAuthGrantId" OR NEW."securityVersion" IS DISTINCT FROM OLD."securityVersion" OR NEW."sessionSecurityVersion" IS DISTINCT FROM OLD."sessionSecurityVersion" OR NEW."normalizedNewEmail" IS DISTINCT FROM OLD."normalizedNewEmail" OR NEW."verificationDigest" IS DISTINCT FROM OLD."verificationDigest" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'email_change_immutable_binding'; END IF;
  IF NEW."state" = 'expired' THEN
    IF NEW."expiresAt" > clock_timestamp() THEN RAISE EXCEPTION 'email_change_not_expired'; END IF;
  ELSE
    IF NEW."expiresAt" <= clock_timestamp() THEN RAISE EXCEPTION 'email_change_deadline_passed'; END IF;
    -- Direct SQL must present the current fresh-auth carrier.  Definer-owned
    -- expiry, delivery-failure, cancellation, and supersession closures are
    -- allowed to close an otherwise stale carrier atomically.
    IF current_user=session_user THEN
      PERFORM "assert_email_change_current_authorization"(NEW."userId", NEW."operationId", NEW."freshAuthGrantId", NEW."securityVersion");
    END IF;
  END IF;
  IF NOT ((OLD."state"='pending' AND NEW."state" IN ('verified','cancelled','abandoned','failed')) OR (OLD."state"='verified' AND NEW."state"='completed') OR (OLD."state" IN ('pending','verified') AND NEW."state"='expired')) THEN RAISE EXCEPTION 'email_change_invalid_transition'; END IF;
  IF (NEW."state"='cancelled' AND NEW."cancelledAt" IS NOT NULL) OR (NEW."state"<>'cancelled' AND NEW."cancelledAt" IS NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'email_change_terminal_state_invalid';
END $$;

CREATE FUNCTION "assert_recovery_session_expiry_finalization"(scope_user_id TEXT, scope_recovery_session_id TEXT, scope_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE recovery_row "RecoverySession"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF scope_recovery_session_id IS NULL THEN RAISE EXCEPTION 'recovery_session_expiry_finalization_required'; END IF;
  SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=scope_recovery_session_id AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF recovery_row."id" IS NULL OR recovery_row."operationId" IS DISTINCT FROM scope_operation_id OR recovery_row."purpose" <> 'recovery_reset' OR recovery_row."state" <> 'restricted' OR recovery_row."expiresAt" > clock_timestamp() OR operation_row."operationKey" <> 'recovery_reset' OR NOT (operation_row."status" IN ('pending','unknown') OR (operation_row."status"='rejected' AND operation_row."outcomeCode"='recovery_session_expired')) OR bound."id" IS NULL OR bound."userId" IS DISTINCT FROM scope_user_id OR bound."operationId" IS DISTINCT FROM scope_operation_id OR bound."operationKey" <> 'recovery_reset' OR bound."recoverySessionId" IS DISTINCT FROM scope_recovery_session_id OR bound."sessionId" IS NOT NULL OR bound."state" <> 'submitted' THEN RAISE EXCEPTION 'recovery_session_expiry_finalization_required'; END IF;
END $$;

CREATE FUNCTION "expire_recovery_session_finalization"(scope_user_id TEXT, scope_recovery_session_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE recovery_row "RecoverySession"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=scope_recovery_session_id AND "userId"=scope_user_id FOR UPDATE;
  PERFORM "assert_recovery_session_expiry_finalization"(scope_user_id, scope_recovery_session_id, recovery_row."operationId");
  UPDATE "GlobalSecurityOperation" SET "status"='rejected', "outcomeVersion"=1, "outcomeCode"='recovery_session_expired', "outcomeSnapshot"='{}', "terminalAt"=clock_timestamp(), "updatedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "operationId"=recovery_row."operationId";
  UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal', "updatedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "operationId"=recovery_row."operationId";
  UPDATE "RecoverySession" SET "state"='expired' WHERE "id"=scope_recovery_session_id AND "userId"=scope_user_id;
  INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('recovery-expiry:' || scope_user_id || ':' || recovery_row."operationId",scope_user_id,'operation_outcome','rejected',recovery_row."operationId",'{}',clock_timestamp());
END $$;

CREATE FUNCTION "enforce_recovery_session_expiry_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE; recovery_row "RecoverySession"%ROWTYPE;
BEGIN
  IF NEW."operationKey" <> 'recovery_reset' OR NEW."status" <> 'rejected' OR NEW."outcomeCode" <> 'recovery_session_expired' THEN RETURN NULL; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=bound."recoverySessionId" AND "userId"=NEW."userId" FOR UPDATE;
  IF bound."id" IS NULL OR bound."operationId" IS DISTINCT FROM NEW."operationId" OR bound."operationKey" <> 'recovery_reset' OR bound."sessionId" IS NOT NULL OR bound."state" <> 'terminal' OR recovery_row."id" IS NULL OR recovery_row."operationId" IS DISTINCT FROM NEW."operationId" OR recovery_row."purpose" <> 'recovery_reset' OR recovery_row."state" <> 'expired' OR recovery_row."consumedAt" IS NOT NULL OR recovery_row."closedAt" IS NOT NULL THEN RAISE EXCEPTION 'recovery_session_expiry_finalization_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='rejected' AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'recovery_session_expiry_event_required'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION "lock_global_security_transition_v1"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  RETURN NULL;
END $$;
CREATE TRIGGER "00_GlobalSecurityOperation_transition_lock" BEFORE INSERT OR UPDATE ON "GlobalSecurityOperation" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_GlobalSecurityOperationBinding_transition_lock" BEFORE INSERT OR UPDATE ON "GlobalSecurityOperationBinding" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_FreshAuthGrant_transition_lock" BEFORE INSERT OR UPDATE ON "FreshAuthGrant" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_RecoveryCodeSet_transition_lock" BEFORE INSERT OR UPDATE ON "RecoveryCodeSet" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_RecoveryCode_transition_lock" BEFORE INSERT OR UPDATE ON "RecoveryCode" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_RecoverySession_transition_lock" BEFORE INSERT OR UPDATE ON "RecoverySession" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE TRIGGER "00_EmailChange_transition_lock" BEFORE INSERT OR UPDATE ON "EmailChange" FOR EACH STATEMENT EXECUTE FUNCTION "lock_global_security_transition_v1"();
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_recovery_expiry_finalization_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_session_expiry_finalization"();

CREATE FUNCTION "guard_global_security_event_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF NEW."eventType" <> 'operation_outcome' OR NEW."safeProjection" <> '{}'::jsonb OR operation_row."operationId" IS NULL OR bound."state" <> 'terminal' OR NOT ((operation_row."status" = 'completed' AND operation_row."outcomeCode" IN ('changed','rehearsal_completed','reset_completed','email_changed') AND NEW."outcome" = 'completed') OR (operation_row."status" = 'rejected' AND NEW."outcome" = 'rejected') OR (operation_row."status" = 'stale' AND operation_row."outcomeCode" = 'stale_security_version' AND NEW."outcome" = 'stale_security_version')) THEN
    RAISE EXCEPTION 'global_security_event_insert_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GlobalSecurityEvent_insert_guard" BEFORE INSERT ON "GlobalSecurityEvent" FOR EACH ROW EXECUTE FUNCTION "guard_global_security_event_insert"();

CREATE OR REPLACE FUNCTION "guard_global_security_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'global_security_tombstone_insert_not_enabled';
END $$;
CREATE OR REPLACE FUNCTION "guard_global_security_reservation_tombstone_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'global_security_reservation_tombstone_insert_not_enabled';
END $$;

CREATE FUNCTION "apply_password_change_credential_mutation"(scope_user_id TEXT, scope_operation_id TEXT, scope_account_id TEXT, replacement_password TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE; bound public."GlobalSecurityOperationBinding"%ROWTYPE; grant_row public."FreshAuthGrant"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO bound FROM public."GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  SELECT * INTO grant_row FROM public."FreshAuthGrant" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF state_row."lastCredentialOperationId" IS DISTINCT FROM scope_operation_id OR operation_row."operationKey" <> 'password_change' OR operation_row."status" <> 'pending' OR bound."state" <> 'submitted' OR grant_row."state" <> 'consumed' THEN RAISE EXCEPTION 'password_change_credential_mutation_required'; END IF;
  IF grant_row."attestationNonce" IS NOT NULL AND (grant_row."replacementPasswordHashDigest" IS NULL OR public.digest(convert_to(replacement_password,'UTF8'),'sha256') IS DISTINCT FROM grant_row."replacementPasswordHashDigest") THEN RAISE EXCEPTION 'replacement_password_hash_attestation_mismatch'; END IF;
  UPDATE public."Account" SET "password"=replacement_password, "updatedAt"=clock_timestamp() WHERE "id"=scope_account_id AND "userId"=scope_user_id AND "providerId"='credential';
  IF NOT FOUND THEN RAISE EXCEPTION 'password_change_credential_mutation_required'; END IF;
  INSERT INTO public."PasswordChangeCredentialMutation" ("userId","operationId","accountId") VALUES (scope_user_id,scope_operation_id,scope_account_id);
END $$;
REVOKE ALL ON FUNCTION "apply_password_change_credential_mutation"(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
CREATE FUNCTION "apply_recovery_reset_credential_mutation"(scope_user_id TEXT, scope_operation_id TEXT, scope_account_id TEXT, replacement_password TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE; bound public."GlobalSecurityOperationBinding"%ROWTYPE; recovery_row public."RecoverySession"%ROWTYPE; code_row public."RecoveryCode"%ROWTYPE; set_row public."RecoveryCodeSet"%ROWTYPE;
BEGIN
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO bound FROM public."GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  SELECT * INTO recovery_row FROM public."RecoverySession" WHERE "id"=bound."recoverySessionId" AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO code_row FROM public."RecoveryCode" WHERE "id"=recovery_row."recoveryCodeId" AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO set_row FROM public."RecoveryCodeSet" WHERE "userId"=code_row."userId" AND "setVersion"=code_row."setVersion" FOR UPDATE;
  IF state_row."lastCredentialOperationId" IS DISTINCT FROM scope_operation_id OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM scope_operation_id OR operation_row."operationKey" <> 'recovery_reset' OR operation_row."status" <> 'pending' OR bound."state" <> 'submitted' OR bound."sessionId" IS NOT NULL OR recovery_row."state" <> 'restricted' OR recovery_row."expiresAt" <= clock_timestamp() OR code_row."state" <> 'consumed' OR code_row."consumedPurpose" <> 'recovery_reset' OR code_row."consumedOperationId" IS DISTINCT FROM scope_operation_id OR set_row."state" <> 'rehearsed' OR EXISTS (SELECT 1 FROM public."RecoveryCodeSet" newer WHERE newer."userId"=scope_user_id AND newer."setVersion">set_row."setVersion" AND newer."state"<>'invalidated') THEN RAISE EXCEPTION 'recovery_reset_credential_mutation_required'; END IF;
  IF session_user='cubby_runtime' AND (recovery_row."attestationNonce" IS NULL OR recovery_row."attestedOpeningFingerprint" IS DISTINCT FROM bound."openingFingerprint" OR recovery_row."attestedIntentFingerprint" IS DISTINCT FROM operation_row."intentFingerprint" OR recovery_row."replacementPasswordHashDigest" IS NULL OR public.digest(convert_to(replacement_password,'UTF8'),'sha256') IS DISTINCT FROM recovery_row."replacementPasswordHashDigest") THEN RAISE EXCEPTION 'recovery_reset_attestation_invalid'; END IF;
  UPDATE public."Account" SET "password"=replacement_password, "updatedAt"=clock_timestamp() WHERE "id"=scope_account_id AND "userId"=scope_user_id AND "providerId"='credential';
  IF NOT FOUND THEN RAISE EXCEPTION 'recovery_reset_credential_mutation_required'; END IF;
  INSERT INTO public."RecoveryResetCredentialMutation" ("userId","operationId","accountId") VALUES (scope_user_id,scope_operation_id,scope_account_id);
END $$;
REVOKE ALL ON FUNCTION "apply_recovery_reset_credential_mutation"(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE UPDATE ("password") ON "Account" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON "PasswordChangeCredentialMutation" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON "RecoveryResetCredentialMutation" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cubby_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "apply_password_change_credential_mutation"(TEXT, TEXT, TEXT, TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "apply_recovery_reset_credential_mutation"(TEXT, TEXT, TEXT, TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "lock_global_security_operation_identity_v1"(TEXT, TEXT) TO cubby_runtime;
    REVOKE INSERT, UPDATE ON "Account" FROM cubby_runtime;
    REVOKE INSERT, UPDATE, DELETE ON "PasswordChangeCredentialMutation" FROM cubby_runtime;
    REVOKE INSERT, UPDATE, DELETE ON "RecoveryResetCredentialMutation" FROM cubby_runtime;
    REVOKE ALL ON TABLE "FreshAuthAttestationKey" FROM cubby_runtime;
    REVOKE ALL ON TABLE "EmailDeliveryEncryptionKey" FROM cubby_runtime;
    REVOKE UPDATE, DELETE ON "EmailChangeDelivery" FROM cubby_runtime;
    REVOKE ALL ON FUNCTION "claim_email_change_delivery"(TEXT),"accept_email_change_delivery"(TEXT,TEXT,INTEGER,BYTEA),"fail_email_change_delivery"(TEXT,TEXT,TEXT) FROM cubby_runtime;
    REVOKE ALL ON FUNCTION "verify_password_fresh_auth_attestation"(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT,BYTEA,TEXT,INTEGER,BYTEA) FROM cubby_runtime;
    REVOKE ALL ON FUNCTION "verify_recovery_reset_attestation"(TEXT,TEXT,INTEGER,TEXT,INTEGER,INTEGER,TEXT,TEXT,BYTEA,TEXT,INTEGER,BYTEA) FROM cubby_runtime;
  END IF;
END $$;
CREATE FUNCTION "prevent_password_change_credential_mutation_change"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'password_change_credential_mutation_immutable';
END $$;
CREATE TRIGGER "PasswordChangeCredentialMutation_immutable" BEFORE UPDATE OR DELETE ON "PasswordChangeCredentialMutation" FOR EACH ROW EXECUTE FUNCTION "prevent_password_change_credential_mutation_change"();
CREATE TRIGGER "PasswordChangeCredentialMutation_retention_truncate_guard" BEFORE TRUNCATE ON "PasswordChangeCredentialMutation" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();
CREATE FUNCTION "prevent_recovery_reset_credential_mutation_change"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'recovery_reset_credential_mutation_immutable';
END $$;
CREATE TRIGGER "RecoveryResetCredentialMutation_immutable" BEFORE UPDATE OR DELETE ON "RecoveryResetCredentialMutation" FOR EACH ROW EXECUTE FUNCTION "prevent_recovery_reset_credential_mutation_change"();
CREATE TRIGGER "RecoveryResetCredentialMutation_retention_truncate_guard" BEFORE TRUNCATE ON "RecoveryResetCredentialMutation" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_global_security_retention_truncate"();

CREATE FUNCTION "enforce_password_change_success_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE; active_sessions INTEGER; active_activities INTEGER;
BEGIN
  IF NEW."operationKey" <> 'password_change' OR NEW."status" <> 'completed' OR NEW."outcomeCode" <> 'changed' THEN RETURN NULL; END IF;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT count(*) INTO active_sessions FROM "Session" WHERE "userId"=NEW."userId";
  SELECT count(*) INTO active_activities FROM "SessionSecurityActivity" WHERE "userId"=NEW."userId" AND "state"='active';
  IF state_row."credentialVersion" <> bound."securityVersion" + 1
    OR state_row."sessionSecurityVersion" <> bound."sessionSecurityVersion" + 1
    OR state_row."lastCredentialOperationId" IS DISTINCT FROM NEW."operationId"
    OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM NEW."operationId"
    OR bound."state" <> 'terminal'
    OR grant_row."state" <> 'consumed'
    OR grant_row."consumedAt" IS NULL
    OR active_sessions <> 0
    OR active_activities <> 0
    OR NOT EXISTS (SELECT 1 FROM "PasswordChangeCredentialMutation" receipt JOIN "Account" account ON account."id"=receipt."accountId" WHERE receipt."userId"=NEW."userId" AND receipt."operationId"=NEW."operationId" AND account."userId"=NEW."userId" AND account."providerId"='credential' AND account."password" IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM "Account" WHERE "userId"=NEW."userId" AND "providerId"='credential' AND "password" IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='completed' AND "safeProjection"='{}'::jsonb)
  THEN RAISE EXCEPTION 'password_change_success_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_password_change_success_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_password_change_success_finalization"();
CREATE FUNCTION "enforce_recovery_enrollment_success_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE; set_row "RecoveryCodeSet"%ROWTYPE; active_codes INTEGER; rehearsal_codes INTEGER;
BEGIN
  IF NEW."operationKey" <> 'recovery_enrollment' OR NEW."status" <> 'completed' OR NEW."outcomeCode" <> 'rehearsal_completed' THEN RETURN NULL; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO set_row FROM "RecoveryCodeSet" WHERE "userId"=NEW."userId" AND "issuanceOperationId"=NEW."operationId" FOR UPDATE;
  SELECT count(*) FILTER (WHERE "state"='active'), count(*) FILTER (WHERE "state"='consumed' AND "consumedPurpose"='enrollment_rehearsal' AND "consumedOperationId"=NEW."operationId") INTO active_codes,rehearsal_codes FROM "RecoveryCode" WHERE "userId"=NEW."userId" AND "setVersion"=set_row."setVersion";
  IF bound."state" <> 'terminal' OR bound."sessionId" IS NULL OR bound."expiresAt" <= NEW."terminalAt" OR set_row."state" <> 'rehearsed' OR set_row."saveAcknowledgedAt" IS NULL OR set_row."rehearsedAt" IS NULL OR active_codes <> 9 OR rehearsal_codes <> 1 OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='completed' AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'recovery_enrollment_success_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_recovery_enrollment_success_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_enrollment_success_finalization"();
CREATE FUNCTION "enforce_recovery_enrollment_failure_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE; set_row "RecoveryCodeSet"%ROWTYPE; rehearsal_codes INTEGER;
BEGIN
  IF NEW."operationKey" <> 'recovery_enrollment' OR NEW."status" <> 'rejected' OR NEW."outcomeCode" <> 'rehearsal_failed' THEN RETURN NULL; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO set_row FROM "RecoveryCodeSet" WHERE "userId"=NEW."userId" AND "issuanceOperationId"=NEW."operationId" FOR UPDATE;
  SELECT count(*) FILTER (WHERE "state"='consumed' AND "consumedPurpose"='enrollment_rehearsal') INTO rehearsal_codes FROM "RecoveryCode" WHERE "userId"=NEW."userId" AND "setVersion"=set_row."setVersion";
  IF bound."state" <> 'terminal' OR bound."expiresAt" <= NEW."terminalAt" OR set_row."state" <> 'rehearsal_required' OR rehearsal_codes <> 0 OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='rejected' AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'recovery_enrollment_failure_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_recovery_enrollment_failure_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_enrollment_failure_finalization"();
CREATE FUNCTION "enforce_recovery_reset_terminal_closure"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE; recovery_row "RecoverySession"%ROWTYPE; expected_event_outcome TEXT;
BEGIN
  IF NEW."operationKey" <> 'recovery_reset' OR NOT ((NEW."status"='stale' AND NEW."outcomeCode"='stale_security_version') OR (NEW."status"='rejected' AND NEW."outcomeCode"='recovery_set_regenerated')) THEN RETURN NULL; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=bound."recoverySessionId" AND "userId"=NEW."userId" FOR UPDATE;
  expected_event_outcome := CASE WHEN NEW."status"='stale' THEN 'stale_security_version' ELSE 'rejected' END;
  IF bound."state" <> 'terminal' OR recovery_row."state" <> 'closed' OR recovery_row."closedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"=expected_event_outcome AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'recovery_reset_terminal_closure_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_recovery_reset_terminal_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_reset_terminal_closure"();
CREATE FUNCTION "enforce_recovery_reset_success_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE state_row "AccountSecurityState"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE; recovery_row "RecoverySession"%ROWTYPE; active_sessions INTEGER; active_activities INTEGER; issued_grants INTEGER;
BEGIN
  IF NEW."operationKey" <> 'recovery_reset' OR NEW."status" <> 'completed' OR NEW."outcomeCode" <> 'reset_completed' THEN RETURN NULL; END IF;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO recovery_row FROM "RecoverySession" WHERE "id"=bound."recoverySessionId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT count(*) INTO active_sessions FROM "Session" WHERE "userId"=NEW."userId";
  SELECT count(*) INTO active_activities FROM "SessionSecurityActivity" WHERE "userId"=NEW."userId" AND "state"='active';
  SELECT count(*) INTO issued_grants FROM "FreshAuthGrant" WHERE "userId"=NEW."userId" AND "state"='issued';
  IF state_row."credentialVersion" <> bound."securityVersion" + 1 OR state_row."sessionSecurityVersion" <> bound."sessionSecurityVersion" + 1 OR state_row."lastCredentialOperationId" IS DISTINCT FROM NEW."operationId" OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM NEW."operationId" OR bound."state" <> 'terminal' OR bound."sessionId" IS NOT NULL OR recovery_row."state" <> 'closed' OR recovery_row."closedAt" IS NULL OR active_sessions <> 0 OR active_activities <> 0 OR issued_grants <> 0 OR NOT EXISTS (SELECT 1 FROM "RecoveryResetCredentialMutation" receipt JOIN "Account" account ON account."id"=receipt."accountId" WHERE receipt."userId"=NEW."userId" AND receipt."operationId"=NEW."operationId" AND account."userId"=NEW."userId" AND account."providerId"='credential' AND account."password" IS NOT NULL) OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='completed' AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'recovery_reset_success_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_recovery_reset_success_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_reset_success_finalization"();
CREATE FUNCTION "enforce_password_change_stale_finalization"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound "GlobalSecurityOperationBinding"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE;
BEGIN
  IF NEW."operationKey" <> 'password_change' OR NEW."status" <> 'stale' OR NEW."outcomeCode" <> 'stale_security_version' THEN RETURN NULL; END IF;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  IF bound."state" <> 'terminal' OR (grant_row."id" IS NOT NULL AND (grant_row."state" <> 'revoked' OR grant_row."revokedAt" IS NULL OR grant_row."consumedAt" IS NOT NULL)) THEN RAISE EXCEPTION 'password_change_stale_finalization_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='stale_security_version' AND "safeProjection"='{}'::jsonb) THEN RAISE EXCEPTION 'global_security_stale_finalization_event_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_password_change_stale_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_password_change_stale_finalization"();

-- Phase 6 email completion is deliberately a SECURITY DEFINER-only mutation.
-- Runtime callers can invoke the procedure but cannot update User.email or the
-- immutable completion receipts directly.
CREATE FUNCTION "guard_user_email_change"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."email" IS DISTINCT FROM OLD."email" AND current_user = session_user THEN
    RAISE EXCEPTION 'user_email_direct_mutation_forbidden';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "User_email_change_guard" BEFORE UPDATE OF "email" ON "User" FOR EACH ROW EXECUTE FUNCTION "guard_user_email_change"();
CREATE FUNCTION "guard_email_change_runtime_transition"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = session_user THEN RAISE EXCEPTION 'email_change_runtime_transition_forbidden'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "00_EmailChange_runtime_transition_guard" BEFORE UPDATE ON "EmailChange" FOR EACH ROW EXECUTE FUNCTION "guard_email_change_runtime_transition"();
CREATE TRIGGER "00_EmailChangeSessionRotation_runtime_transition_guard" BEFORE UPDATE ON "EmailChangeSessionRotation" FOR EACH ROW EXECUTE FUNCTION "guard_email_change_runtime_transition"();

CREATE FUNCTION "verify_email_change_token"(scope_user_id TEXT, scope_operation_id TEXT, raw_token TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  IF change_row."id" IS NOT NULL AND change_row."state" IN ('pending','verified') AND (state_row."credentialVersion" IS DISTINCT FROM change_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion") THEN
    PERFORM public."stale_email_change"(scope_user_id,scope_operation_id);
    RETURN QUERY SELECT 'stale_security_version'::TEXT;
    RETURN;
  END IF;
  IF change_row."id" IS NULL OR change_row."state" <> 'pending' OR change_row."expiresAt" <= clock_timestamp()
    OR encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex') IS DISTINCT FROM change_row."verificationDigest"
    OR NOT EXISTS (SELECT 1 FROM public."EmailChangeDelivery" delivery WHERE delivery."emailChangeId"=change_row."id" AND delivery."kind"='new_verification' AND delivery."state"='accepted') THEN
    RAISE EXCEPTION 'email_change_verification_unavailable';
  END IF;
  UPDATE public."EmailChange" SET "state"='verified', "updatedAt"=clock_timestamp() WHERE "id"=change_row."id";
  RETURN QUERY SELECT 'verified'::TEXT;
END $$;

CREATE FUNCTION "complete_verified_email_change"(scope_user_id TEXT, scope_operation_id TEXT, old_session_id TEXT, successor_session_id TEXT, successor_token TEXT, successor_token_digest BYTEA, successor_expires_at TIMESTAMP(3), prepared_invitations JSONB, prepared_deliveries JSONB)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; old_email TEXT; now_time TIMESTAMP(3); state_row public."AccountSecurityState"%ROWTYPE; grant_row public."FreshAuthGrant"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE; old_activity public."SessionSecurityActivity"%ROWTYPE; old_invite_ids TEXT[]; prepared_old_ids TEXT[]; invitation_item JSONB; delivery_item JSONB; old_invite public."Invite"%ROWTYPE; expected_inviter_notices INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  IF change_row."id" IS NOT NULL AND change_row."state" IN ('pending','verified') AND (state_row."credentialVersion" IS DISTINCT FROM change_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion") THEN
    PERFORM public."stale_email_change"(scope_user_id,scope_operation_id);
    RETURN QUERY SELECT 'stale_security_version'::TEXT;
    RETURN;
  END IF;
  SELECT * INTO grant_row FROM public."FreshAuthGrant" WHERE "id"=change_row."freshAuthGrantId" FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO old_activity FROM public."SessionSecurityActivity" WHERE "sessionId"=old_session_id AND "userId"=scope_user_id FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state" <> 'verified' OR change_row."expiresAt" <= clock_timestamp()
    OR octet_length(successor_token_digest) <> 32 OR successor_token_digest IS DISTINCT FROM digest(convert_to(successor_token,'UTF8'),'sha256')
    OR state_row."userId" IS NULL OR state_row."credentialVersion" IS DISTINCT FROM change_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion"
    OR grant_row."id" IS NULL OR grant_row."userId" IS DISTINCT FROM scope_user_id OR grant_row."operationId" IS DISTINCT FROM scope_operation_id OR grant_row."sessionId" IS DISTINCT FROM old_session_id OR grant_row."purpose" IS DISTINCT FROM 'email_change' OR grant_row."state" IS DISTINCT FROM 'issued' OR grant_row."credentialVersion" IS DISTINCT FROM change_row."securityVersion" OR grant_row."expiresAt"<=clock_timestamp()
    OR binding_row."id" IS NULL OR binding_row."operationKey" IS DISTINCT FROM 'email_change' OR binding_row."sessionId" IS DISTINCT FROM old_session_id OR binding_row."securityVersion" IS DISTINCT FROM change_row."securityVersion" OR binding_row."sessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion" OR binding_row."state" IS DISTINCT FROM 'submitted'
    OR old_activity."sessionId" IS NULL OR old_activity."state" IS DISTINCT FROM 'active' OR old_activity."issuanceSessionSecurityVersion" IS DISTINCT FROM change_row."sessionSecurityVersion"
    OR NOT EXISTS (SELECT 1 FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "operationKey"='email_change' AND "status"='pending')
    OR NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=old_session_id AND "userId"=scope_user_id AND "expiresAt">clock_timestamp())
    OR EXISTS (SELECT 1 FROM public."User" WHERE "id"<>scope_user_id AND "normalize_security_email_v1"("email")=change_row."normalizedNewEmail") THEN
    RAISE EXCEPTION 'email_change_completion_unavailable';
  END IF;
  SELECT "email" INTO old_email FROM public."User" WHERE "id"=scope_user_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-identity:v1:' || public."normalize_security_email_v1"(old_email),0));
  PERFORM pg_advisory_xact_lock(hashtextextended('email-identity:v1:' || change_row."normalizedNewEmail",0));
  IF EXISTS (SELECT 1 FROM public."User" WHERE "id"<>scope_user_id AND public."normalize_security_email_v1"("email")=change_row."normalizedNewEmail")
    OR EXISTS (SELECT 1 FROM public."EmailChange" other_change WHERE other_change."id"<>change_row."id" AND other_change."normalizedNewEmail"=change_row."normalizedNewEmail" AND other_change."state" IN ('pending','verified'))
  THEN RAISE EXCEPTION 'email_change_target_reservation_lost'; END IF;
  IF jsonb_typeof(prepared_invitations)<>'array' OR jsonb_typeof(prepared_deliveries)<>'array' THEN RAISE EXCEPTION 'email_change_invitation_set_mismatch'; END IF;
  SELECT array_agg(locked."id" ORDER BY locked."id") INTO old_invite_ids FROM (
    SELECT invite."id" FROM public."Invite" invite
    WHERE public."normalize_security_email_v1"(invite."email")=public."normalize_security_email_v1"(old_email)
      AND invite."status"='pending' AND invite."expiresAt">clock_timestamp()
    ORDER BY invite."id" FOR UPDATE
  ) locked;
  SELECT array_agg(item->>'oldInviteId' ORDER BY item->>'oldInviteId') INTO prepared_old_ids FROM jsonb_array_elements(prepared_invitations) item;
  IF COALESCE(old_invite_ids,ARRAY[]::TEXT[]) IS DISTINCT FROM COALESCE(prepared_old_ids,ARRAY[]::TEXT[])
    OR jsonb_array_length(prepared_invitations)<>(SELECT count(DISTINCT item->>'oldInviteId') FROM jsonb_array_elements(prepared_invitations) item)
  THEN RAISE EXCEPTION 'email_change_invitation_set_mismatch'; END IF;
  IF COALESCE(array_length(old_invite_ids,1),0)=0 THEN
    IF jsonb_array_length(prepared_deliveries)<>0 THEN RAISE EXCEPTION 'email_change_invitation_delivery_mismatch'; END IF;
  ELSE
    SELECT count(DISTINCT public."normalize_security_email_v1"(inviter."email")) INTO expected_inviter_notices
    FROM public."Invite" invite JOIN public."User" inviter ON inviter."id"=invite."invitedByUserId"
    WHERE invite."id"=ANY(old_invite_ids);
    IF (SELECT count(*) FROM jsonb_array_elements(prepared_deliveries) item WHERE item->>'kind'='invitation_reissue')<>1
      OR (SELECT count(*) FROM jsonb_array_elements(prepared_deliveries) item WHERE item->>'kind'='inviter_notice')<>expected_inviter_notices
      OR (SELECT count(*) FROM jsonb_array_elements(prepared_deliveries))<>1+expected_inviter_notices
    THEN RAISE EXCEPTION 'email_change_invitation_delivery_mismatch'; END IF;
  END IF;
  now_time := clock_timestamp();
  UPDATE public."Invite" SET "status"='revoked',"revokedAt"=now_time,"updatedAt"=now_time WHERE "id"=ANY(COALESCE(old_invite_ids,ARRAY[]::TEXT[]));
  FOR invitation_item IN SELECT value FROM jsonb_array_elements(prepared_invitations) LOOP
    SELECT * INTO old_invite FROM public."Invite" WHERE "id"=invitation_item->>'oldInviteId' FOR UPDATE;
    IF old_invite."id" IS NULL OR old_invite."status"<>'revoked' OR invitation_item->>'newInviteId' IS NULL OR invitation_item->>'newInviteId'=''
      OR COALESCE(invitation_item->>'tokenHash','') !~ '^sha256:[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'email_change_invitation_set_mismatch'; END IF;
    INSERT INTO public."Invite" ("id","householdId","email","role","tokenHash","status","invitedByUserId","expiresAt","createdAt","updatedAt")
    VALUES (invitation_item->>'newInviteId',old_invite."householdId",change_row."normalizedNewEmail",old_invite."role",invitation_item->>'tokenHash','pending',old_invite."invitedByUserId",old_invite."expiresAt",now_time,now_time);
  END LOOP;
  FOR delivery_item IN SELECT value FROM jsonb_array_elements(prepared_deliveries) LOOP
    IF delivery_item->>'kind' NOT IN ('invitation_reissue','inviter_notice')
      OR COALESCE(delivery_item->>'id','')='' OR COALESCE(delivery_item->>'recipientDigestHex','') !~ '^[0-9a-f]{64}$'
      OR COALESCE(delivery_item->>'ciphertextHex','') !~ '^[0-9a-f]+$' OR COALESCE(delivery_item->>'ivHex','') !~ '^[0-9a-f]{24}$'
      OR COALESCE(delivery_item->>'authTagHex','') !~ '^[0-9a-f]{32}$' OR COALESCE(delivery_item->>'aadDigestHex','') !~ '^[0-9a-f]{64}$'
      OR COALESCE((delivery_item->>'keyVersion')::INTEGER,0)<1
      OR NOT EXISTS (SELECT 1 FROM public."EmailDeliveryEncryptionKey" WHERE "keyVersion"=(delivery_item->>'keyVersion')::INTEGER AND "activeWrite"=true)
      OR (delivery_item->>'kind'='invitation_reissue' AND decode(delivery_item->>'recipientDigestHex','hex')<>digest(convert_to(change_row."normalizedNewEmail",'UTF8'),'sha256'))
      OR (delivery_item->>'kind'='inviter_notice' AND NOT EXISTS (
        SELECT 1 FROM public."Invite" old_row JOIN public."User" inviter ON inviter."id"=old_row."invitedByUserId"
        WHERE old_row."id"=ANY(old_invite_ids) AND digest(convert_to(public."normalize_security_email_v1"(inviter."email"),'UTF8'),'sha256')=decode(delivery_item->>'recipientDigestHex','hex')
      ))
    THEN RAISE EXCEPTION 'email_change_invitation_delivery_mismatch'; END IF;
    INSERT INTO public."EmailChangeDelivery" ("id","userId","emailChangeId","operationId","kind","recipientDigest","state","ciphertext","iv","authTag","aadDigest","keyVersion","attemptCount","nextAttemptAt","createdAt","updatedAt")
    VALUES (delivery_item->>'id',scope_user_id,change_row."id",scope_operation_id,(delivery_item->>'kind')::public."EmailChangeDeliveryKind",decode(delivery_item->>'recipientDigestHex','hex'),'queued',decode(delivery_item->>'ciphertextHex','hex'),decode(delivery_item->>'ivHex','hex'),decode(delivery_item->>'authTagHex','hex'),decode(delivery_item->>'aadDigestHex','hex'),(delivery_item->>'keyVersion')::INTEGER,0,now_time,now_time,now_time);
  END LOOP;
  UPDATE public."FreshAuthGrant" SET "state"='consumed',"consumedAt"=now_time WHERE "id"=change_row."freshAuthGrantId" AND "state"='issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'email_change_completion_unavailable'; END IF;
  UPDATE public."EmailChange" SET "state"='completed',"updatedAt"=now_time WHERE "id"=change_row."id";
  INSERT INTO public."EmailChangeIdentityMutation" ("userId","operationId","oldEmailDigest","newEmailDigest","createdAt") VALUES (scope_user_id,scope_operation_id,digest(convert_to(old_email,'UTF8'),'sha256'),digest(convert_to(change_row."normalizedNewEmail",'UTF8'),'sha256'),now_time);
  UPDATE public."User" SET "email"=change_row."normalizedNewEmail", "emailVerified"=true, "updatedAt"=now_time WHERE "id"=scope_user_id;
  INSERT INTO public."Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES (successor_session_id,successor_token,successor_expires_at,scope_user_id,now_time,now_time);
  INSERT INTO public."SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") VALUES (successor_session_id,scope_user_id,change_row."sessionSecurityVersion"+1,old_activity."originalCreatedAt",now_time,'active',now_time);
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "sessionId"<>successor_session_id AND "state"='active';
  DELETE FROM public."Session" WHERE "userId"=scope_user_id AND "id"<>successor_session_id;
  UPDATE public."AccountSecurityState" SET "credentialVersion"="credentialVersion"+1,"sessionSecurityVersion"="sessionSecurityVersion"+1,"lastCredentialOperationId"=scope_operation_id,"lastSessionSecurityOperationId"=scope_operation_id,"securityUpdatedAt"=now_time WHERE "userId"=scope_user_id;
  UPDATE public."GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='cutover_completed',"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  INSERT INTO public."EmailChangeSessionRotation" ("userId","operationId","oldSessionId","successorSessionId","successorTokenDigest","activityOriginalCreatedAt","issuedAt") VALUES (scope_user_id,scope_operation_id,old_session_id,successor_session_id,successor_token_digest,old_activity."originalCreatedAt",now_time);
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('email-change:' || scope_user_id || ':' || scope_operation_id,scope_user_id,'operation_outcome','completed',scope_operation_id,'{}',now_time);
  RETURN QUERY SELECT 'completed'::TEXT;
END $$;

CREATE FUNCTION "confirm_email_change_rotation_cookie"(scope_user_id TEXT, scope_operation_id TEXT, successor_session_id TEXT, successor_token_digest BYTEA)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public."EmailChangeSessionRotation" SET "cookieState"='confirmed',"confirmedAt"=clock_timestamp()
  WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "successorSessionId"=successor_session_id AND "successorTokenDigest"=successor_token_digest AND "cookieState"='issued' AND "issuedAt"+INTERVAL '5 minutes'>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'email_change_cookie_confirmation_unavailable'; END IF;
  RETURN QUERY SELECT 'confirmed'::TEXT;
END $$;
-- Phase 6 lifecycle closures.  These run as definer-owned, all-or-nothing
-- transitions: a terminal change never leaves a usable grant, lease, or
-- ciphertext behind.  Runtime roles receive only these narrow procedures.
CREATE OR REPLACE FUNCTION "enforce_email_change_delivery_transition"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF; RAISE EXCEPTION 'email_change_delivery_immutable'; END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."emailChangeId" IS DISTINCT FROM OLD."emailChangeId" OR NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."recipientDigest" IS DISTINCT FROM OLD."recipientDigest" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'email_change_delivery_identity_immutable'; END IF;
  IF OLD."state" IN ('accepted','permanent_failed') OR NOT ((OLD."state"='queued' AND NEW."state"='dispatching') OR (OLD."state"='dispatching' AND NEW."state" IN ('accepted','retryable_failed','permanent_failed')) OR (OLD."state"='retryable_failed' AND NEW."state" IN ('dispatching','permanent_failed')) OR (current_user<>session_user AND OLD."state" IN ('queued','retryable_failed') AND NEW."state"='permanent_failed')) THEN RAISE EXCEPTION 'email_change_delivery_invalid_transition'; END IF;
  IF NEW."state"='accepted' AND (NEW."smtpResponseCode"<>250 OR NEW."messageIdDigest" IS NULL OR octet_length(NEW."messageIdDigest")<>32 OR NEW."acceptedAt" IS NULL OR NEW."lastFailureCode" IS NOT NULL) THEN RAISE EXCEPTION 'email_change_delivery_receipt_required'; END IF;
  IF NEW."state"='permanent_failed' AND NEW."lastFailureCode" NOT IN ('attempts_exhausted','payload_decrypt','receipt_invalid','recipient_rejected','smtp_auth','smtp_rejected','delivery_failed','cancelled','expired','abandoned','stale_security_version') THEN RAISE EXCEPTION 'email_change_delivery_failure_code_invalid'; END IF;
  RETURN NEW;
END $$;

-- PostgreSQL CHECK accepts UNKNOWN.  Spell every nullable ciphertext member
-- out explicitly so hostile runtime SQL cannot smuggle a partial outbox row.
ALTER TABLE "EmailChangeDelivery" DROP CONSTRAINT "EmailChangeDelivery_shape_check";
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_shape_check" CHECK (
  "recipientDigest" IS NOT NULL AND octet_length("recipientDigest")=32 AND "attemptCount" BETWEEN 0 AND 8 AND
  (("state" IN ('queued','dispatching','retryable_failed') AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND octet_length("iv")=12 AND "authTag" IS NOT NULL AND octet_length("authTag")=16 AND "aadDigest" IS NOT NULL AND octet_length("aadDigest")=32 AND "keyVersion" IS NOT NULL) OR
   ("state" IN ('accepted','permanent_failed') AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "aadDigest" IS NULL AND "keyVersion" IS NULL))
);
ALTER TABLE "EmailChangeDelivery" DROP CONSTRAINT "EmailChangeDelivery_lease_receipt_check";
ALTER TABLE "EmailChangeDelivery" ADD CONSTRAINT "EmailChangeDelivery_lease_receipt_check" CHECK (
  (("state"='dispatching' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR ("state"<>'dispatching' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)) AND
  (("state"='accepted' AND "smtpResponseCode"=250 AND "messageIdDigest" IS NOT NULL AND octet_length("messageIdDigest")=32 AND "acceptedAt" IS NOT NULL AND "lastFailureCode" IS NULL) OR
   ("state"<>'accepted' AND "smtpResponseCode" IS NULL AND "messageIdDigest" IS NULL AND "acceptedAt" IS NULL))
);
CREATE OR REPLACE FUNCTION "enforce_email_change_delivery_insert"() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row "EmailChange"%ROWTYPE; operation_row "GlobalSecurityOperation"%ROWTYPE;
BEGIN
  SELECT * INTO change_row FROM "EmailChange" WHERE "userId"=NEW."userId" AND "id"=NEW."emailChangeId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  IF NEW."userId" IS NULL OR NEW."emailChangeId" IS NULL OR NEW."operationId" IS NULL OR NEW."recipientDigest" IS NULL OR NEW."keyVersion" IS NULL
    OR change_row."id" IS NULL OR change_row."state" NOT IN ('pending','verified','completed')
    OR operation_row."operationKey" IS DISTINCT FROM 'email_change' OR operation_row."status" NOT IN ('pending','unknown','completed')
    OR NEW."state" IS DISTINCT FROM 'queued' OR NEW."attemptCount" IS DISTINCT FROM 0
    OR NOT EXISTS (SELECT 1 FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=NEW."keyVersion" AND "activeWrite"=true)
  THEN RAISE EXCEPTION 'email_change_delivery_insert_invalid'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "guard_user_email_change"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."email" IS DISTINCT FROM OLD."email" OR NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified") AND current_user=session_user THEN RAISE EXCEPTION 'user_email_direct_mutation_forbidden'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "User_email_change_guard" ON "User";
CREATE TRIGGER "User_email_change_guard" BEFORE UPDATE OF "email","emailVerified" ON "User" FOR EACH ROW EXECUTE FUNCTION "guard_user_email_change"();
CREATE FUNCTION "guard_email_change_identity_mutation_insert"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
  IF current_user=session_user THEN RAISE EXCEPTION 'email_change_identity_mutation_runtime_forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "EmailChange" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "state"='completed') THEN RAISE EXCEPTION 'email_change_identity_mutation_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmailChangeIdentityMutation_insert_guard" BEFORE INSERT ON "EmailChangeIdentityMutation" FOR EACH ROW EXECUTE FUNCTION "guard_email_change_identity_mutation_insert"();
CREATE FUNCTION "guard_email_change_session_rotation_insert"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE successor_session public."Session"%ROWTYPE; successor_activity public."SessionSecurityActivity"%ROWTYPE;
BEGIN
  IF current_user=session_user THEN RAISE EXCEPTION 'email_change_session_rotation_runtime_forbidden'; END IF;
  SELECT * INTO successor_session FROM public."Session" WHERE "id"=NEW."successorSessionId" AND "userId"=NEW."userId" FOR UPDATE;
  SELECT * INTO successor_activity FROM public."SessionSecurityActivity" WHERE "sessionId"=NEW."successorSessionId" AND "userId"=NEW."userId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM "EmailChange" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "state"='completed') THEN RAISE EXCEPTION 'email_change_session_rotation_invalid'; END IF;
  IF successor_session."id" IS NULL OR successor_activity."sessionId" IS NULL OR successor_activity."state"<>'active' OR successor_activity."originalCreatedAt" IS DISTINCT FROM NEW."activityOriginalCreatedAt" THEN RAISE EXCEPTION 'email_change_rotation_successor_session_required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmailChangeSessionRotation_insert_guard" BEFORE INSERT ON "EmailChangeSessionRotation" FOR EACH ROW EXECUTE FUNCTION "guard_email_change_session_rotation_insert"();

CREATE OR REPLACE FUNCTION "guard_global_security_event_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation_row "GlobalSecurityOperation"%ROWTYPE; bound "GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  SELECT * INTO operation_row FROM "GlobalSecurityOperation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO bound FROM "GlobalSecurityOperationBinding" WHERE "id"=operation_row."bindingId" FOR UPDATE;
  IF NEW."eventType" <> 'operation_outcome' OR NEW."safeProjection" <> '{}'::jsonb OR operation_row."operationId" IS NULL OR bound."state" <> 'terminal' OR NOT (
    (operation_row."status" = 'completed' AND operation_row."outcomeCode" IN ('changed','rehearsal_completed','reset_completed','email_changed','cutover_completed') AND NEW."outcome" = 'completed') OR
    (operation_row."operationKey"='session_revoke' AND operation_row."status"='completed' AND operation_row."outcomeCode" IN ('revoked','already_revoked') AND NEW."outcome"=operation_row."outcomeCode") OR
    (operation_row."status" = 'rejected' AND NEW."outcome" = 'rejected') OR
    (operation_row."status" = 'stale' AND operation_row."outcomeCode" = 'stale_security_version' AND NEW."outcome" = 'stale_security_version')
  ) THEN RAISE EXCEPTION 'global_security_event_insert_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION "enforce_email_change_cutover_finalization"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE change_row "EmailChange"%ROWTYPE; binding_row "GlobalSecurityOperationBinding"%ROWTYPE; state_row "AccountSecurityState"%ROWTYPE;
BEGIN
  IF NEW."operationKey"<>'email_change' OR NEW."status"<>'completed' OR NEW."outcomeCode"<>'cutover_completed' THEN RETURN NULL; END IF;
  SELECT * INTO change_row FROM "EmailChange" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO binding_row FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO state_row FROM "AccountSecurityState" WHERE "userId"=NEW."userId" FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state"<>'completed' OR binding_row."state"<>'terminal'
    OR state_row."credentialVersion"<>change_row."securityVersion"+1 OR state_row."sessionSecurityVersion"<>change_row."sessionSecurityVersion"+1
    OR state_row."lastCredentialOperationId" IS DISTINCT FROM NEW."operationId" OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM NEW."operationId"
    OR NOT EXISTS (SELECT 1 FROM "EmailChangeIdentityMutation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId")
    OR NOT EXISTS (SELECT 1 FROM "EmailChangeSessionRotation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId")
    OR EXISTS (SELECT 1 FROM "Session" WHERE "userId"=NEW."userId" AND "id"<>(SELECT "successorSessionId" FROM "EmailChangeSessionRotation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId"))
    OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='completed' AND "safeProjection"='{}'::jsonb)
  THEN RAISE EXCEPTION 'email_change_cutover_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_email_change_cutover_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_cutover_finalization"();

CREATE FUNCTION "enforce_email_change_stale_finalization"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE change_row "EmailChange"%ROWTYPE; binding_row "GlobalSecurityOperationBinding"%ROWTYPE; grant_row "FreshAuthGrant"%ROWTYPE;
BEGIN
  IF NEW."operationKey"<>'email_change' OR NEW."status"<>'stale' OR NEW."outcomeCode"<>'stale_security_version' THEN RETURN NULL; END IF;
  SELECT * INTO change_row FROM "EmailChange" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO binding_row FROM "GlobalSecurityOperationBinding" WHERE "id"=NEW."bindingId" FOR UPDATE;
  SELECT * INTO grant_row FROM "FreshAuthGrant" WHERE "id"=change_row."freshAuthGrantId" FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state"<>'failed' OR binding_row."state"<>'terminal'
    OR (grant_row."id" IS NOT NULL AND grant_row."state" NOT IN ('revoked','expired'))
    OR EXISTS (SELECT 1 FROM "EmailChangeDelivery" WHERE "emailChangeId"=change_row."id" AND "state" IN ('queued','dispatching','retryable_failed'))
    OR EXISTS (SELECT 1 FROM "EmailChangeIdentityMutation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId")
    OR EXISTS (SELECT 1 FROM "EmailChangeSessionRotation" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId")
    OR NOT EXISTS (SELECT 1 FROM "GlobalSecurityEvent" WHERE "userId"=NEW."userId" AND "operationId"=NEW."operationId" AND "eventType"='operation_outcome' AND "outcome"='stale_security_version' AND "safeProjection"='{}'::jsonb)
  THEN RAISE EXCEPTION 'email_change_stale_finalization_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_email_change_stale_guard" AFTER UPDATE ON "GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_email_change_stale_finalization"();

CREATE FUNCTION "terminalize_email_change"(scope_user_id TEXT, scope_operation_id TEXT, terminal_state "EmailChangeState", terminal_code TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; now_time TIMESTAMP(3);
BEGIN
  IF terminal_state NOT IN ('cancelled','expired','abandoned','failed') OR terminal_code NOT IN ('cancelled','verification_expired','abandoned','delivery_failed') THEN RAISE EXCEPTION 'email_change_terminalization_invalid'; END IF;
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state" NOT IN ('pending','verified') THEN RAISE EXCEPTION 'email_change_terminalization_unavailable'; END IF;
  now_time:=clock_timestamp();
  UPDATE public."EmailChangeDelivery" SET "state"='permanent_failed',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"lastFailureCode"=CASE WHEN terminal_code='verification_expired' THEN 'expired' ELSE terminal_code END,"updatedAt"=now_time WHERE "emailChangeId"=change_row."id" AND "state" IN ('queued','dispatching','retryable_failed');
  UPDATE public."FreshAuthGrant" SET "state"='revoked',"revokedAt"=now_time WHERE "id"=change_row."freshAuthGrantId" AND "state"='issued';
  UPDATE public."EmailChange" SET "state"=terminal_state,"cancelledAt"=CASE WHEN terminal_state='cancelled' THEN now_time ELSE NULL END,"updatedAt"=now_time WHERE "id"=change_row."id";
  UPDATE public."GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"=terminal_code,"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "status"='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'email_change_terminalization_unavailable'; END IF;
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('email-terminal:' || scope_user_id || ':' || scope_operation_id,scope_user_id,'operation_outcome','rejected',scope_operation_id,'{}',now_time);
END $$;

CREATE FUNCTION "stale_email_change"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; now_time TIMESTAMP(3);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state" NOT IN ('pending','verified') OR binding_row."state"<>'submitted'
    OR (state_row."credentialVersion"=change_row."securityVersion" AND state_row."sessionSecurityVersion"=change_row."sessionSecurityVersion")
    OR NOT EXISTS (SELECT 1 FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "operationKey"='email_change' AND "status"='pending')
  THEN RAISE EXCEPTION 'email_change_stale_unavailable'; END IF;
  now_time:=clock_timestamp();
  UPDATE public."EmailChangeDelivery" SET "state"='permanent_failed',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"lastFailureCode"='stale_security_version',"updatedAt"=now_time WHERE "emailChangeId"=change_row."id" AND "state" IN ('queued','dispatching','retryable_failed');
  UPDATE public."FreshAuthGrant" SET "state"='revoked',"revokedAt"=now_time WHERE "id"=change_row."freshAuthGrantId" AND "state"='issued';
  UPDATE public."EmailChange" SET "state"='failed',"updatedAt"=now_time WHERE "id"=change_row."id";
  UPDATE public."GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "status"='pending';
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('email-stale:' || scope_user_id || ':' || scope_operation_id,scope_user_id,'operation_outcome','stale_security_version',scope_operation_id,'{}',now_time);
  RETURN QUERY SELECT 'stale_security_version'::TEXT;
END $$;

CREATE FUNCTION "cancel_email_change"(scope_user_id TEXT, scope_operation_id TEXT, scope_session_id TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF change_row."id" IS NULL OR change_row."state" NOT IN ('pending','verified') OR binding_row."state"<>'submitted' OR binding_row."sessionId" IS DISTINCT FROM scope_session_id
    OR NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id AND "expiresAt">clock_timestamp())
  THEN RAISE EXCEPTION 'email_change_cancellation_authorization_required'; END IF;
  PERFORM public."terminalize_email_change"(scope_user_id,scope_operation_id,'cancelled','cancelled');
  RETURN QUERY SELECT 'cancelled'::TEXT;
END $$;
CREATE FUNCTION "expire_email_change"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row public."EmailChange"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF row."id" IS NULL OR row."state" NOT IN ('pending','verified') OR row."expiresAt">clock_timestamp() THEN RAISE EXCEPTION 'email_change_expiry_unavailable'; END IF;
  PERFORM public."terminalize_email_change"(scope_user_id,scope_operation_id,'expired','verification_expired');
  RETURN QUERY SELECT 'expired'::TEXT;
END $$;
CREATE FUNCTION "supersede_email_changes"(scope_user_id TEXT, except_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row public."EmailChange"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  FOR row IN SELECT * FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"<>except_operation_id AND "state" IN ('pending','verified') ORDER BY "id" FOR UPDATE LOOP
    PERFORM public."terminalize_email_change"(scope_user_id,row."operationId",'abandoned','abandoned');
  END LOOP;
END $$;
CREATE FUNCTION "reject_email_change_collision"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE now_time TIMESTAMP(3);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); now_time:=clock_timestamp();
  UPDATE public."FreshAuthGrant" SET "state"='revoked',"revokedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "state"='issued';
  UPDATE public."GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='collision_rejected',"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id AND "operationKey"='email_change' AND "status"='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'email_change_collision_unavailable'; END IF;
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('email-collision:' || scope_user_id || ':' || scope_operation_id,scope_user_id,'operation_outcome','rejected',scope_operation_id,'{}',now_time);
END $$;

CREATE OR REPLACE FUNCTION "fail_email_change_delivery"(delivery_id TEXT,worker_token TEXT,failure_code TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE retryable BOOLEAN; exhausted BOOLEAN; delivery_row public."EmailChangeDelivery"%ROWTYPE;
BEGIN
  retryable:=failure_code IN ('smtp_connection','smtp_rate_limited','smtp_temporary','smtp_timeout');
  IF NOT retryable AND failure_code NOT IN ('payload_decrypt','receipt_invalid','recipient_rejected','smtp_auth','smtp_rejected') THEN RAISE EXCEPTION 'email_delivery_failure_code_invalid'; END IF;
  SELECT * INTO delivery_row FROM public."EmailChangeDelivery" WHERE "id"=delivery_id AND "state"='dispatching' AND "leaseOwner"=worker_token FOR UPDATE;
  IF delivery_row."id" IS NULL OR delivery_row."leaseExpiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'email_delivery_lease_lost'; END IF;
  exhausted:=delivery_row."attemptCount">=8;
  UPDATE public."EmailChangeDelivery" SET "state"=CASE WHEN retryable AND NOT exhausted THEN 'retryable_failed'::public."EmailChangeDeliveryState" ELSE 'permanent_failed'::public."EmailChangeDeliveryState" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN retryable AND NOT exhausted THEN public."email_change_delivery_retry_at"(delivery_row."attemptCount") ELSE NULL END,"lastFailureCode"=CASE WHEN retryable AND exhausted THEN 'attempts_exhausted' ELSE failure_code END,"ciphertext"=CASE WHEN retryable AND NOT exhausted THEN "ciphertext" ELSE NULL END,"iv"=CASE WHEN retryable AND NOT exhausted THEN "iv" ELSE NULL END,"authTag"=CASE WHEN retryable AND NOT exhausted THEN "authTag" ELSE NULL END,"aadDigest"=CASE WHEN retryable AND NOT exhausted THEN "aadDigest" ELSE NULL END,"keyVersion"=CASE WHEN retryable AND NOT exhausted THEN "keyVersion" ELSE NULL END,"updatedAt"=clock_timestamp() WHERE "id"=delivery_id;
  IF delivery_row."kind"='new_verification' AND (NOT retryable OR exhausted) THEN PERFORM public."terminalize_email_change"(delivery_row."userId",delivery_row."operationId",'failed','delivery_failed'); END IF;
END $$;

CREATE FUNCTION "expire_unconfirmed_email_change_rotation"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public."EmailChangeSessionRotation"%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM public."EmailChangeSessionRotation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF receipt."cookieState"='failed' AND NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=receipt."successorSessionId" AND "userId"=scope_user_id) THEN RETURN QUERY SELECT 'failed'::TEXT; RETURN; END IF;
  IF receipt."userId" IS NULL OR receipt."cookieState"<>'issued' OR receipt."issuedAt"+INTERVAL '5 minutes'>clock_timestamp() THEN RAISE EXCEPTION 'email_change_cookie_expiry_unavailable'; END IF;
  UPDATE public."EmailChangeSessionRotation" SET "cookieState"='failed',"failedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "sessionId"=receipt."successorSessionId" AND "state"='active';
  DELETE FROM public."Session" WHERE "id"=receipt."successorSessionId" AND "userId"=scope_user_id;
  RETURN QUERY SELECT 'failed'::TEXT;
END $$;
CREATE FUNCTION "fail_email_change_rotation_cookie"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS TABLE(result_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public."EmailChangeSessionRotation"%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM public."EmailChangeSessionRotation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF receipt."cookieState"='failed' AND NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=receipt."successorSessionId" AND "userId"=scope_user_id) THEN RETURN QUERY SELECT 'failed'::TEXT; RETURN; END IF;
  IF receipt."userId" IS NULL OR receipt."cookieState"<>'issued' THEN RAISE EXCEPTION 'email_change_cookie_failure_unavailable'; END IF;
  UPDATE public."EmailChangeSessionRotation" SET "cookieState"='failed',"failedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=clock_timestamp() WHERE "userId"=scope_user_id AND "sessionId"=receipt."successorSessionId" AND "state"='active';
  DELETE FROM public."Session" WHERE "id"=receipt."successorSessionId" AND "userId"=scope_user_id;
  RETURN QUERY SELECT 'failed'::TEXT;
END $$;
CREATE FUNCTION "get_email_change_status"(scope_user_id TEXT, scope_operation_id TEXT, scope_session_id TEXT)
RETURNS TABLE(result_state TEXT, old_address_notice_failed BOOLEAN, cookie_state TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_row public."EmailChange"%ROWTYPE; binding public."GlobalSecurityOperationBinding"%ROWTYPE; receipt public."EmailChangeSessionRotation"%ROWTYPE;
BEGIN
  SELECT * INTO change_row FROM public."EmailChange" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  SELECT * INTO binding FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  SELECT * INTO receipt FROM public."EmailChangeSessionRotation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  IF change_row."id" IS NULL OR binding."id" IS NULL THEN RAISE EXCEPTION 'email_change_status_unavailable'; END IF;
  IF change_row."state"='completed' THEN
    IF receipt."successorSessionId" IS NULL OR receipt."successorSessionId" IS DISTINCT FROM scope_session_id OR NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id AND "expiresAt">clock_timestamp()) THEN RAISE EXCEPTION 'email_change_status_unavailable'; END IF;
  ELSIF binding."sessionId" IS DISTINCT FROM scope_session_id OR NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id AND "expiresAt">clock_timestamp()) THEN RAISE EXCEPTION 'email_change_status_unavailable'; END IF;
  RETURN QUERY SELECT change_row."state"::TEXT, EXISTS(SELECT 1 FROM public."EmailChangeDelivery" WHERE "emailChangeId"=change_row."id" AND "kind"='old_cutover' AND "state"='permanent_failed'), COALESCE(receipt."cookieState"::TEXT,'not_issued');
END $$;

CREATE OR REPLACE FUNCTION "claim_email_change_delivery"(worker_token TEXT) RETURNS SETOF "EmailChangeDelivery" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expired_delivery public."EmailChangeDelivery"%ROWTYPE;
BEGIN
  IF worker_token !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION 'email_delivery_worker_invalid'; END IF;
  FOR expired_delivery IN SELECT * FROM public."EmailChangeDelivery" WHERE "state"='dispatching' AND "leaseExpiresAt"<=clock_timestamp() ORDER BY "id" FOR UPDATE LOOP
    IF expired_delivery."attemptCount">=8 THEN
      UPDATE public."EmailChangeDelivery" SET "state"='permanent_failed',"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"lastFailureCode"='attempts_exhausted',"ciphertext"=NULL,"iv"=NULL,"authTag"=NULL,"aadDigest"=NULL,"keyVersion"=NULL,"updatedAt"=clock_timestamp() WHERE "id"=expired_delivery."id";
      IF expired_delivery."kind"='new_verification' THEN
        PERFORM public."terminalize_email_change"(expired_delivery."userId",expired_delivery."operationId",'failed','delivery_failed');
      END IF;
    ELSE
      UPDATE public."EmailChangeDelivery" SET "state"='retryable_failed',"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=public."email_change_delivery_retry_at"("attemptCount"),"lastFailureCode"='smtp_timeout',"updatedAt"=clock_timestamp() WHERE "id"=expired_delivery."id";
    END IF;
  END LOOP;
  RETURN QUERY WITH candidate AS (
    SELECT delivery."id" FROM public."EmailChangeDelivery" delivery
    JOIN public."EmailChange" change_row ON change_row."id"=delivery."emailChangeId" AND change_row."userId"=delivery."userId" AND change_row."operationId"=delivery."operationId"
    WHERE delivery."state" IN ('queued','retryable_failed') AND (delivery."nextAttemptAt" IS NULL OR delivery."nextAttemptAt"<=clock_timestamp()) AND delivery."attemptCount"<8
      AND (delivery."kind" IN ('new_verification','old_request') OR change_row."state"='completed')
    ORDER BY delivery."nextAttemptAt" NULLS FIRST,delivery."createdAt" FOR UPDATE OF delivery SKIP LOCKED LIMIT 1
  ) UPDATE public."EmailChangeDelivery" delivery SET "state"='dispatching',"leaseOwner"=worker_token,"leaseExpiresAt"=clock_timestamp()+INTERVAL '5 minutes',"attemptCount"=delivery."attemptCount"+1,"updatedAt"=clock_timestamp() FROM candidate WHERE delivery."id"=candidate."id" RETURNING delivery.*;
END $$;

CREATE FUNCTION "run_email_change_lifecycle_batch"(batch_limit INTEGER)
RETURNS TABLE(expired_changes INTEGER, expired_rotations INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE change_candidate RECORD; rotation_candidate RECORD; change_count INTEGER:=0; rotation_count INTEGER:=0;
BEGIN
  IF batch_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'email_change_lifecycle_batch_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  FOR change_candidate IN
    SELECT "userId","operationId" FROM public."EmailChange"
    WHERE "state" IN ('pending','verified') AND "expiresAt"<=clock_timestamp()
    ORDER BY "expiresAt","id" FOR UPDATE SKIP LOCKED LIMIT batch_limit
  LOOP
    PERFORM public."expire_email_change"(change_candidate."userId",change_candidate."operationId");
    change_count:=change_count+1;
  END LOOP;
  FOR rotation_candidate IN
    SELECT "userId","operationId" FROM public."EmailChangeSessionRotation"
    WHERE "cookieState"='issued' AND "issuedAt"+INTERVAL '5 minutes'<=clock_timestamp()
    ORDER BY "issuedAt","operationId" FOR UPDATE SKIP LOCKED LIMIT batch_limit
  LOOP
    PERFORM public."expire_unconfirmed_email_change_rotation"(rotation_candidate."userId",rotation_candidate."operationId");
    rotation_count:=rotation_count+1;
  END LOOP;
  RETURN QUERY SELECT change_count,rotation_count;
END $$;
REVOKE ALL ON FUNCTION "run_email_change_lifecycle_batch"(INTEGER) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "run_email_change_lifecycle_batch"(INTEGER) TO cubby_runtime;
  END IF;
END $$;

-- The runtime client may use the narrowly scoped dispatch procedures but has
-- no table DML authority over completion receipts or rotation evidence.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE ON "EmailChangeIdentityMutation","EmailChangeSessionRotation","EmailDeliveryEncryptionKey" FROM cubby_runtime;
    REVOKE UPDATE ("email","emailVerified") ON "User" FROM cubby_runtime;
  END IF;
END $$;

REVOKE ALL ON FUNCTION "verify_email_change_token"(TEXT,TEXT,TEXT),"complete_verified_email_change"(TEXT,TEXT,TEXT,TEXT,TEXT,BYTEA,TIMESTAMP(3),JSONB,JSONB),"confirm_email_change_rotation_cookie"(TEXT,TEXT,TEXT,BYTEA),"stale_email_change"(TEXT,TEXT),"cancel_email_change"(TEXT,TEXT,TEXT),"expire_email_change"(TEXT,TEXT),"supersede_email_changes"(TEXT,TEXT),"reject_email_change_collision"(TEXT,TEXT),"expire_unconfirmed_email_change_rotation"(TEXT,TEXT),"fail_email_change_rotation_cookie"(TEXT,TEXT),"get_email_change_status"(TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "verify_email_change_token"(TEXT,TEXT,TEXT),"complete_verified_email_change"(TEXT,TEXT,TEXT,TEXT,TEXT,BYTEA,TIMESTAMP(3),JSONB,JSONB),"confirm_email_change_rotation_cookie"(TEXT,TEXT,TEXT,BYTEA),"stale_email_change"(TEXT,TEXT),"cancel_email_change"(TEXT,TEXT,TEXT),"expire_email_change"(TEXT,TEXT),"supersede_email_changes"(TEXT,TEXT),"reject_email_change_collision"(TEXT,TEXT),"expire_unconfirmed_email_change_rotation"(TEXT,TEXT),"fail_email_change_rotation_cookie"(TEXT,TEXT),"get_email_change_status"(TEXT,TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

-- Phase 7 starts with a complete activity record for sessions which existed
-- before the security table and for every ordinary Better Auth session after it.
INSERT INTO public."AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") SELECT DISTINCT "userId",1,1,clock_timestamp() FROM public."Session" WHERE "expiresAt">clock_timestamp()
ON CONFLICT ("userId") DO NOTHING;
INSERT INTO public."SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") SELECT session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",session_row."createdAt",'active',clock_timestamp() FROM public."Session" session_row JOIN public."AccountSecurityState" state_row ON state_row."userId"=session_row."userId" WHERE session_row."expiresAt">clock_timestamp()
ON CONFLICT ("sessionId") DO NOTHING;

CREATE FUNCTION "initialize_global_session_security_activity"(scope_user_id TEXT, scope_session_id TEXT)
RETURNS TABLE("initialized" BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE session_row public."Session"%ROWTYPE; activity_row public."SessionSecurityActivity"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  INSERT INTO public."AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") SELECT scope_user_id,1,1,clock_timestamp() WHERE EXISTS (SELECT 1 FROM public."User" WHERE "id"=scope_user_id)
  ON CONFLICT ("userId") DO NOTHING;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE;
  IF state_row."userId" IS NULL OR session_row."id" IS NULL OR session_row."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'session_security_activity_session_mismatch';
  END IF;
  INSERT INTO public."SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","warningAt","state","updatedAt")
  VALUES (session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",session_row."createdAt",NULL,'active',clock_timestamp())
  ON CONFLICT ("sessionId") DO NOTHING;
  SELECT * INTO activity_row FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_session_id FOR UPDATE;
  IF activity_row."sessionId" IS NULL OR activity_row."userId" IS DISTINCT FROM scope_user_id
    OR activity_row."issuanceSessionSecurityVersion" IS DISTINCT FROM state_row."sessionSecurityVersion" OR activity_row."originalCreatedAt" IS DISTINCT FROM session_row."createdAt" THEN
    RAISE EXCEPTION 'session_security_activity_session_mismatch';
  END IF;
  RETURN QUERY SELECT true;
END $$;
REVOKE ALL ON FUNCTION "initialize_global_session_security_activity"(TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "initialize_global_session_security_activity"(TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

CREATE FUNCTION "authorize_global_session_security"(scope_user_id TEXT, scope_session_id TEXT, qualifying_use TEXT)
RETURNS TABLE("authorized" BOOLEAN, "expiresAt" TIMESTAMP(3), "lastQualifyingAt" TIMESTAMP(3), "idleWarningAt" TIMESTAMP(3))
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; session_row public."Session"%ROWTYPE; activity_row public."SessionSecurityActivity"%ROWTYPE; effective_expiry TIMESTAMP(3); now_time TIMESTAMP(3);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  INSERT INTO public."AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt")
  SELECT scope_user_id,1,1,clock_timestamp() WHERE EXISTS (SELECT 1 FROM public."User" WHERE "id"=scope_user_id)
  ON CONFLICT ("userId") DO NOTHING;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE;
  IF state_row."userId" IS NULL OR session_row."id" IS NULL THEN
    RETURN QUERY SELECT false,NULL::TIMESTAMP(3),NULL::TIMESTAMP(3),NULL::TIMESTAMP(3); RETURN;
  END IF;
  INSERT INTO public."SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","warningAt","state","updatedAt")
  VALUES (session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",session_row."createdAt",NULL,'active',clock_timestamp())
  ON CONFLICT ("sessionId") DO NOTHING;
  SELECT * INTO activity_row FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_session_id AND "userId"=scope_user_id FOR UPDATE;
  IF activity_row."sessionId" IS NULL OR activity_row."state" <> 'active' THEN
    RETURN QUERY SELECT false,NULL::TIMESTAMP(3),NULL::TIMESTAMP(3),NULL::TIMESTAMP(3); RETURN;
  END IF;
  IF activity_row."issuanceSessionSecurityVersion" IS DISTINCT FROM state_row."sessionSecurityVersion" THEN
    now_time:=clock_timestamp();
    UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "sessionId"=scope_session_id AND "state"='active';
    DELETE FROM public."Session" WHERE "id"=session_row."id" AND "userId"=scope_user_id;
    RETURN QUERY SELECT false,NULL::TIMESTAMP(3),NULL::TIMESTAMP(3),NULL::TIMESTAMP(3); RETURN;
  END IF;
  effective_expiry:=LEAST(session_row."expiresAt",activity_row."originalCreatedAt"+INTERVAL '90 days',activity_row."lastQualifyingAt"+INTERVAL '30 days');
  IF clock_timestamp() >= effective_expiry THEN
    now_time:=clock_timestamp();
    UPDATE public."SessionSecurityActivity" SET "state"='expired'::public."SessionSecurityActivityState","updatedAt"=now_time WHERE "sessionId"=scope_session_id AND "state"='active';
    DELETE FROM public."Session" WHERE "id"=session_row."id" AND "userId"=scope_user_id;
    RETURN QUERY SELECT false,NULL::TIMESTAMP(3),NULL::TIMESTAMP(3),NULL::TIMESTAMP(3); RETURN;
  END IF;
  IF qualifying_use IS NOT NULL THEN
    IF qualifying_use NOT IN ('foreground_document_navigation','cubby_owned_non_get_mutation','private_security_action') THEN
      RAISE EXCEPTION 'session_security_qualifying_use_invalid';
    END IF;
    now_time:=clock_timestamp();
    UPDATE public."SessionSecurityActivity" SET "lastQualifyingAt"=now_time,"updatedAt"=now_time WHERE "sessionId"=scope_session_id;
    activity_row."lastQualifyingAt":=now_time;
    effective_expiry:=LEAST(session_row."expiresAt",activity_row."originalCreatedAt"+INTERVAL '90 days',activity_row."lastQualifyingAt"+INTERVAL '30 days');
  END IF;
  now_time:=clock_timestamp();
  IF activity_row."warningAt" IS NULL AND now_time >= effective_expiry - INTERVAL '7 days' THEN
    UPDATE public."SessionSecurityActivity" SET "warningAt"=now_time,"updatedAt"=now_time WHERE "sessionId"=scope_session_id AND "warningAt" IS NULL;
    activity_row."warningAt":=now_time;
  END IF;
  RETURN QUERY SELECT true,effective_expiry,activity_row."lastQualifyingAt",activity_row."warningAt";
END $$;
REVOKE ALL ON FUNCTION "authorize_global_session_security"(TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "authorize_global_session_security"(TEXT,TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

CREATE FUNCTION "list_global_session_security"(scope_user_id TEXT, scope_current_session_id TEXT)
RETURNS TABLE("sessionId" TEXT,"userAgent" TEXT,"createdAt" TIMESTAMP(3),"lastQualifyingAt" TIMESTAMP(3),"idleWarningAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3))
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE is_authorized BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT "authorized" INTO is_authorized FROM public."authorize_global_session_security"(scope_user_id,scope_current_session_id,NULL);
  IF is_authorized IS DISTINCT FROM true THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  RETURN QUERY SELECT session_row."id",session_row."userAgent",session_row."createdAt",activity."lastQualifyingAt",activity."warningAt",
    LEAST(session_row."expiresAt",activity."originalCreatedAt"+INTERVAL '90 days',activity."lastQualifyingAt"+INTERVAL '30 days')
  FROM public."Session" session_row
  JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId"
  JOIN public."AccountSecurityState" security_state ON security_state."userId"=session_row."userId"
  WHERE session_row."userId"=scope_user_id AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=security_state."sessionSecurityVersion"
    AND LEAST(session_row."expiresAt",activity."originalCreatedAt"+INTERVAL '90 days',activity."lastQualifyingAt"+INTERVAL '30 days')>clock_timestamp()
  ORDER BY session_row."createdAt" DESC,session_row."id" DESC;
END $$;
REVOKE ALL ON FUNCTION "list_global_session_security"(TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION "revoke_sessions_for_global_security_operation"(scope_user_id TEXT, scope_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE; now_time TIMESTAMP(3);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF state_row."userId" IS NULL OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM scope_operation_id
    OR operation_row."operationId" IS NULL OR operation_row."operationKey" NOT IN ('password_change','recovery_reset') OR operation_row."status" NOT IN ('pending','unknown')
  THEN RAISE EXCEPTION 'global_security_session_revocation_authorization_required'; END IF;
  now_time:=clock_timestamp();
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "state"='active';
  DELETE FROM public."Session" WHERE "userId"=scope_user_id;
END $$;

CREATE FUNCTION "revoke_sessions_for_suspended_member"(scope_household_id TEXT, scope_member_id TEXT, scope_user_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_row public."HouseholdMember"%ROWTYPE; now_time TIMESTAMP(3);
BEGIN
  SELECT * INTO member_row FROM public."HouseholdMember" WHERE "householdId"=scope_household_id AND "id"=scope_member_id AND "userId"=scope_user_id FOR UPDATE;
  IF member_row."id" IS NULL OR member_row."disabledAt" IS NULL OR member_row."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'suspended_member_session_revocation_authorization_required'; END IF;
  now_time:=clock_timestamp();
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "state"='active';
  DELETE FROM public."Session" WHERE "userId"=scope_user_id;
END $$;

CREATE FUNCTION "complete_session_revoke"(scope_user_id TEXT, scope_current_session_id TEXT, scope_operation_id TEXT, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT)
RETURNS TABLE("status" TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; current_row public."Session"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE; grant_row public."FreshAuthGrant"%ROWTYPE; revoke_scope TEXT; target_handle TEXT; target_session_id TEXT; deleted_count INTEGER; now_time TIMESTAMP(3); outcome TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO grant_row FROM public."FreshAuthGrant" WHERE "userId"=scope_user_id AND "sessionId"=scope_current_session_id AND "operationId"=scope_operation_id AND "purpose"='session_revoke' FOR UPDATE;
  IF state_row."userId" IS NULL OR binding_row."id" IS NULL OR operation_row."bindingId" IS DISTINCT FROM binding_row."id" OR binding_row."operationKey"<>'session_revoke' OR binding_row."sessionId" IS DISTINCT FROM scope_current_session_id OR binding_row."openingFingerprint" IS DISTINCT FROM scope_opening_fingerprint OR binding_row."state"<>'submitted' OR operation_row."operationKey"<>'session_revoke' OR operation_row."intentFingerprint" IS DISTINCT FROM scope_intent_fingerprint OR operation_row."status"<>'pending' THEN RAISE EXCEPTION 'session_revoke_binding_invalid'; END IF;
  IF state_row."credentialVersion" IS DISTINCT FROM binding_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM binding_row."sessionSecurityVersion" THEN
    now_time:=clock_timestamp();
    UPDATE public."FreshAuthGrant" SET "state"='revoked',"revokedAt"=now_time WHERE "id"=grant_row."id" AND "state"='issued';
    UPDATE public."GlobalSecurityOperation" operation_update SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE operation_update."userId"=scope_user_id AND operation_update."operationId"=scope_operation_id AND operation_update."status"='pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'session_revoke_stale_finalization_invalid'; END IF;
    UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
    INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('session-revoke:'||scope_operation_id,scope_user_id,'operation_outcome','stale_security_version',scope_operation_id,'{}',now_time);
    RETURN QUERY SELECT 'stale_security_version'::TEXT; RETURN;
  END IF;
  SELECT * INTO current_row FROM public."Session" WHERE "id"=scope_current_session_id AND "userId"=scope_user_id FOR UPDATE;
  IF current_row."id" IS NULL OR current_row."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'session_revoke_current_authorization_required'; END IF;
  revoke_scope:=binding_row."targetSnapshot"->>'scope'; target_handle:=binding_row."targetSnapshot"->>'canonicalTargetHandle'; target_session_id:=binding_row."targetSnapshot"->>'resolvedTargetSessionId';
  IF binding_row."targetSnapshot" IS DISTINCT FROM jsonb_build_object('scope',revoke_scope,'canonicalTargetHandle',target_handle,'resolvedTargetSessionId',target_session_id) OR revoke_scope NOT IN ('current','one','others','all') OR (revoke_scope='current' AND target_session_id IS DISTINCT FROM scope_current_session_id) OR (revoke_scope='one' AND (target_session_id IS NULL OR target_session_id=scope_current_session_id)) OR (revoke_scope IN ('others','all') AND (target_handle IS DISTINCT FROM 'absent_target_handle' OR target_session_id IS DISTINCT FROM 'absent_target_session_id')) THEN RAISE EXCEPTION 'session_revoke_target_snapshot_invalid'; END IF;
  PERFORM 1 FROM public."Session" WHERE "userId"=scope_user_id AND "id"<>scope_current_session_id ORDER BY "id" FOR UPDATE;
  PERFORM 1 FROM public."SessionSecurityActivity" WHERE "userId"=scope_user_id ORDER BY "sessionId" FOR UPDATE;
  IF operation_row."bindingId" IS NULL OR operation_row."operationKey"<>'session_revoke' OR operation_row."intentFingerprint" IS DISTINCT FROM scope_intent_fingerprint OR operation_row."status"<>'pending' OR binding_row."state"<>'submitted' OR grant_row."id" IS NULL OR grant_row."state"<>'issued' OR grant_row."expiresAt"<=clock_timestamp() OR NOT public."verify_session_revoke_attestation"(scope_user_id,scope_current_session_id,scope_operation_id,state_row."credentialVersion",state_row."sessionSecurityVersion",revoke_scope,target_handle,target_session_id,scope_opening_fingerprint,scope_intent_fingerprint,grant_row."attestationNonce",grant_row."attestationKeyVersion",grant_row."attestationMac") THEN RAISE EXCEPTION 'session_revoke_authorization_required'; END IF;
  now_time:=clock_timestamp();
  UPDATE public."FreshAuthGrant" SET "state"='consumed',"consumedAt"=now_time WHERE "id"=grant_row."id";
  IF revoke_scope='current' THEN
    UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "sessionId"=scope_current_session_id AND "userId"=scope_user_id AND "state"='active';
    DELETE FROM public."Session" WHERE "id"=scope_current_session_id AND "userId"=scope_user_id; GET DIAGNOSTICS deleted_count=ROW_COUNT;
  ELSIF revoke_scope='one' THEN
    UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "sessionId"=target_session_id AND "userId"=scope_user_id AND "state"='active';
    DELETE FROM public."Session" WHERE "id"=target_session_id AND "userId"=scope_user_id; GET DIAGNOSTICS deleted_count=ROW_COUNT;
  ELSIF revoke_scope='others' THEN
    UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "sessionId"<>scope_current_session_id AND "state"='active';
    DELETE FROM public."Session" WHERE "userId"=scope_user_id AND "id"<>scope_current_session_id; GET DIAGNOSTICS deleted_count=ROW_COUNT;
  ELSE
    UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time WHERE "userId"=scope_user_id AND "state"='active';
    DELETE FROM public."Session" WHERE "userId"=scope_user_id; GET DIAGNOSTICS deleted_count=ROW_COUNT;
    UPDATE public."AccountSecurityState" SET "sessionSecurityVersion"="sessionSecurityVersion"+1,"lastSessionSecurityOperationId"=scope_operation_id,"securityUpdatedAt"=now_time WHERE "userId"=scope_user_id;
  END IF;
  outcome:=CASE WHEN deleted_count>0 THEN 'revoked' ELSE 'already_revoked' END;
  UPDATE public."GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"=outcome,"outcomeSnapshot"='{}',"terminalAt"=now_time,"updatedAt"=now_time WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id;
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('session-revoke:'||scope_operation_id,scope_user_id,'operation_outcome',outcome,scope_operation_id,'{}',now_time);
  RETURN QUERY SELECT outcome;
END $$;

CREATE FUNCTION "get_session_revoke_status"(scope_user_id TEXT, scope_current_session_id TEXT, scope_operation_id TEXT, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT)
RETURNS TABLE("status" TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE; revoke_scope TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  revoke_scope:=binding_row."targetSnapshot"->>'scope';
  IF state_row."userId" IS NULL OR binding_row."id" IS NULL OR operation_row."bindingId" IS DISTINCT FROM binding_row."id" OR binding_row."operationKey"<>'session_revoke' OR operation_row."operationKey"<>'session_revoke' OR binding_row."openingFingerprint" IS DISTINCT FROM scope_opening_fingerprint OR operation_row."intentFingerprint" IS DISTINCT FROM scope_intent_fingerprint THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  IF binding_row."state"='submitted' AND operation_row."status" IN ('pending','unknown') THEN
    IF binding_row."sessionId" IS DISTINCT FROM scope_current_session_id OR state_row."credentialVersion" IS DISTINCT FROM binding_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM binding_row."sessionSecurityVersion" OR NOT EXISTS (SELECT 1 FROM public."Session" session_row JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId" WHERE session_row."id"=scope_current_session_id AND session_row."userId"=scope_user_id AND session_row."expiresAt">clock_timestamp() AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=state_row."sessionSecurityVersion") THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
    RETURN QUERY SELECT operation_row."status"::TEXT;
    RETURN;
  END IF;
  IF binding_row."state"<>'terminal' OR operation_row."status" NOT IN ('completed','stale') THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  IF operation_row."status"='stale' THEN
    IF NOT EXISTS (SELECT 1 FROM public."Session" session_row JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId" WHERE session_row."id"=scope_current_session_id AND session_row."userId"=scope_user_id AND session_row."expiresAt">clock_timestamp() AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=state_row."sessionSecurityVersion") THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  ELSIF revoke_scope='current' THEN
    IF state_row."credentialVersion" IS DISTINCT FROM binding_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM binding_row."sessionSecurityVersion" OR scope_current_session_id IS NOT DISTINCT FROM binding_row."sessionId" OR NOT EXISTS (SELECT 1 FROM public."Session" session_row JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId" WHERE session_row."id"=scope_current_session_id AND session_row."userId"=scope_user_id AND session_row."expiresAt">clock_timestamp() AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=state_row."sessionSecurityVersion") THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  ELSIF revoke_scope='all' THEN
    IF state_row."credentialVersion" IS DISTINCT FROM binding_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM binding_row."sessionSecurityVersion"+1 OR state_row."lastSessionSecurityOperationId" IS DISTINCT FROM scope_operation_id OR scope_current_session_id IS NOT DISTINCT FROM binding_row."sessionId" OR NOT EXISTS (SELECT 1 FROM public."Session" session_row JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId" WHERE session_row."id"=scope_current_session_id AND session_row."userId"=scope_user_id AND session_row."expiresAt">clock_timestamp() AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=state_row."sessionSecurityVersion") THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  ELSIF binding_row."sessionId" IS DISTINCT FROM scope_current_session_id OR state_row."credentialVersion" IS DISTINCT FROM binding_row."securityVersion" OR state_row."sessionSecurityVersion" IS DISTINCT FROM binding_row."sessionSecurityVersion" OR NOT EXISTS (SELECT 1 FROM public."Session" WHERE "id"=scope_current_session_id AND "userId"=scope_user_id AND "expiresAt">clock_timestamp()) THEN RAISE EXCEPTION 'session_revoke_status_unavailable'; END IF;
  RETURN QUERY SELECT operation_row."outcomeCode";
END $$;

CREATE FUNCTION "get_session_revoke_retry_target"(scope_user_id TEXT, scope_current_session_id TEXT, scope_operation_id TEXT, scope_opening_fingerprint TEXT, scope_intent_fingerprint TEXT)
RETURNS TABLE("scope" TEXT,"canonicalTargetHandle" TEXT,"resolvedTargetSessionId" TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state_row public."AccountSecurityState"%ROWTYPE; binding_row public."GlobalSecurityOperationBinding"%ROWTYPE; operation_row public."GlobalSecurityOperation"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF binding_row."id" IS NULL THEN RETURN; END IF;
  SELECT * INTO operation_row FROM public."GlobalSecurityOperation" WHERE "userId"=scope_user_id AND "operationId"=scope_operation_id FOR UPDATE;
  IF operation_row."bindingId" IS DISTINCT FROM binding_row."id" OR binding_row."operationKey"<>'session_revoke' OR operation_row."operationKey"<>'session_revoke' OR binding_row."openingFingerprint" IS DISTINCT FROM scope_opening_fingerprint OR operation_row."intentFingerprint" IS DISTINCT FROM scope_intent_fingerprint THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  IF binding_row."state"='submitted' AND operation_row."status" IN ('pending','unknown') AND binding_row."sessionId"=scope_current_session_id AND state_row."credentialVersion"=binding_row."securityVersion" AND state_row."sessionSecurityVersion"=binding_row."sessionSecurityVersion" AND EXISTS (SELECT 1 FROM public."Session" session_row JOIN public."SessionSecurityActivity" activity ON activity."sessionId"=session_row."id" AND activity."userId"=session_row."userId" WHERE session_row."id"=scope_current_session_id AND session_row."userId"=scope_user_id AND session_row."expiresAt">clock_timestamp() AND activity."state"='active' AND activity."issuanceSessionSecurityVersion"=state_row."sessionSecurityVersion") THEN
    RETURN QUERY SELECT binding_row."targetSnapshot"->>'scope',binding_row."targetSnapshot"->>'canonicalTargetHandle',binding_row."targetSnapshot"->>'resolvedTargetSessionId';
  END IF;
END $$;
REVOKE ALL ON FUNCTION "get_session_revoke_retry_target"(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

REVOKE ALL ON FUNCTION "revoke_sessions_for_global_security_operation"(TEXT,TEXT),"revoke_sessions_for_suspended_member"(TEXT,TEXT,TEXT) FROM PUBLIC;

-- Better Auth's restricted role may create a Session, while the existing
-- membership trigger retains owner-only access to household authorization rows.
ALTER FUNCTION public."require_active_membership_for_session"() SECURITY DEFINER;
ALTER FUNCTION public."require_active_membership_for_session"() SET search_path=pg_catalog,public;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_auth') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO cubby_auth', current_database());
    REVOKE ALL ON SCHEMA public FROM cubby_auth;
    GRANT USAGE ON SCHEMA public TO cubby_auth;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cubby_auth;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM cubby_auth;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM cubby_auth;
    GRANT SELECT ON TABLE "User","Account","Verification","Session" TO cubby_auth;
    GRANT INSERT, UPDATE, DELETE ON TABLE "Session" TO cubby_auth;
    REVOKE INSERT, UPDATE, DELETE ON TABLE "Account" FROM cubby_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE ON "Session","SessionSecurityActivity" FROM cubby_runtime;
    REVOKE ALL ON FUNCTION "initialize_global_session_security_activity"(TEXT,TEXT),"authorize_global_session_security"(TEXT,TEXT,TEXT),"list_global_session_security"(TEXT,TEXT),"revoke_sessions_for_global_security_operation"(TEXT,TEXT),"revoke_sessions_for_suspended_member"(TEXT,TEXT,TEXT),"complete_session_revoke"(TEXT,TEXT,TEXT,TEXT,TEXT),"get_session_revoke_status"(TEXT,TEXT,TEXT,TEXT,TEXT),"get_session_revoke_retry_target"(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION "initialize_global_session_security_activity"(TEXT,TEXT),"authorize_global_session_security"(TEXT,TEXT,TEXT),"list_global_session_security"(TEXT,TEXT),"revoke_sessions_for_global_security_operation"(TEXT,TEXT),"revoke_sessions_for_suspended_member"(TEXT,TEXT,TEXT),"complete_session_revoke"(TEXT,TEXT,TEXT,TEXT,TEXT),"get_session_revoke_status"(TEXT,TEXT,TEXT,TEXT,TEXT),"get_session_revoke_retry_target"(TEXT,TEXT,TEXT,TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

COMMIT;
