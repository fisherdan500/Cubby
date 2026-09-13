BEGIN;

-- household_deletion_deferred_fail_closed

CREATE SCHEMA IF NOT EXISTS invitation_protocol;
CREATE ROLE invitation_protocol_owner_NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE TYPE invitation_protocol."InvitationOperationKind" AS ENUM (
  'PRESENTATION_CLAIM','MANUAL_INVITE_CREATE','MANUAL_INVITE_REPLACE','CREDENTIAL_SETUP','RECOVERY_ENROLLMENT','RECOVERY_REHEARSAL','MEMBERSHIP_ACCEPTANCE','INVITE_REVOKE','INVITE_REVOKE_ALL'
);
CREATE TYPE invitation_protocol."InvitationOperationState" AS ENUM (
  'PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND','PRESENTATION_CLOSED','PREPARED','SUBMITTED','TERMINAL_FULL','COMPACTED','ABANDONED'
);
CREATE TYPE invitation_protocol."InvitationTombstoneClass" AS ENUM ('FULL_COMPACTION','RESERVATION_CLOSE');
CREATE TYPE invitation_protocol."InvitationRecoveryChallengeState" AS ENUM ('issued','consumed','expired');
CREATE TYPE invitation_protocol.presentation_close_reason AS ENUM ('explicit_close','expiry','revoke','consume');
CREATE TYPE invitation_protocol.invitation_audit_action AS ENUM ('invite.claim','invite.close','invite.create','invite.replace','credential.setup','recovery.enroll','recovery.rehearse','membership.accept','invite.revoke','invite.revoke_all','invite.expire','invitation.operation.compact');
CREATE TYPE invitation_protocol.invitation_request_attestation AS (
  ordinary_session_id TEXT, subject_user_id TEXT, issuer_membership_episode_id TEXT, subject_membership_episode_id TEXT,
  operation_kind invitation_protocol."InvitationOperationKind", operation_id UUID, target TEXT,
  opening_fingerprint BYTEA, intent_fingerprint BYTEA, purpose TEXT, key_version INTEGER, nonce BYTEA, issued_at TIMESTAMPTZ, mac BYTEA
);
CREATE TYPE invitation_protocol.invitation_preaccount_credential_attestation AS (
  claim_identity_id UUID, browser_partition_digest BYTEA, recipient_email_digest BYTEA,
  operation_kind invitation_protocol."InvitationOperationKind", operation_id UUID, opening_fingerprint BYTEA,
  intent_fingerprint BYTEA, password_hash_digest BYTEA, key_version INTEGER, nonce BYTEA, issued_at TIMESTAMPTZ, mac BYTEA
);
CREATE TYPE invitation_protocol.invitation_credential_status_attestation AS (
  claim_identity_id UUID, browser_partition_digest BYTEA, recipient_email_digest BYTEA,
  operation_kind invitation_protocol."InvitationOperationKind", operation_id UUID, key_version INTEGER, nonce BYTEA, issued_at TIMESTAMPTZ, mac BYTEA
);
CREATE TYPE invitation_protocol.invitation_public_token_claim AS (token_hash_digest BYTEA, key_version INTEGER, issued_at TIMESTAMPTZ, nonce BYTEA, mac BYTEA);
CREATE TYPE invitation_protocol.invitation_expiry_worker_carrier AS (worker_nonce BYTEA, issued_at TIMESTAMPTZ, invite_id TEXT);
CREATE TYPE invitation_protocol.invitation_maintenance_worker_carrier AS (worker_nonce BYTEA, issued_at TIMESTAMPTZ, identity_id UUID);
CREATE TYPE invitation_protocol.invitation_setup_corridor_attestation AS (ordinary_session_id TEXT, subject_user_id TEXT, purpose TEXT, key_version INTEGER, nonce BYTEA, issued_at TIMESTAMPTZ, mac BYTEA);
CREATE TYPE invitation_protocol.setup_corridor_result AS ENUM ('setup_required','ordinary','neutral');
CREATE TYPE invitation_protocol.invitation_owner_private_call_attestation AS (marker TEXT);
CREATE TYPE invitation_protocol.recovery_verifier_record AS (code_id TEXT, ordinal INTEGER, salt BYTEA, derived_key BYTEA, kdf_version INTEGER);
CREATE TYPE invitation_protocol.recovery_verifier_batch AS (records invitation_protocol.recovery_verifier_record[], batch_digest BYTEA);

CREATE TABLE invitation_protocol."InvitationProcedureTransitionBinding" (
  "procedureName" TEXT PRIMARY KEY,
  "operationKind" invitation_protocol."InvitationOperationKind",
  "transition" TEXT NOT NULL,
  "identityBehavior" TEXT NOT NULL
);
INSERT INTO invitation_protocol."InvitationProcedureTransitionBinding" ("procedureName","operationKind","transition","identityBehavior") VALUES
('claim_invitation_presentation_v2','PRESENTATION_CLAIM','claim','create_new_identity'),('close_invitation_presentation_v2','PRESENTATION_CLAIM','close','existing_identity_transition'),
('reserve_manual_invite_create_v2','MANUAL_INVITE_CREATE','reserve','create_new_identity'),('submit_manual_invite_create_v2','MANUAL_INVITE_CREATE','submit_begin+submit_terminal','existing_identity_transition'),('status_manual_invite_create_v2','MANUAL_INVITE_CREATE','status','existing_identity_transition'),('abandon_manual_invite_create_v2','MANUAL_INVITE_CREATE','abandon','existing_identity_transition'),
('reserve_manual_invite_replace_v2','MANUAL_INVITE_REPLACE','reserve','create_new_identity'),('submit_manual_invite_replace_v2','MANUAL_INVITE_REPLACE','submit_begin+submit_terminal','existing_identity_transition'),('status_manual_invite_replace_v2','MANUAL_INVITE_REPLACE','status','existing_identity_transition'),('abandon_manual_invite_replace_v2','MANUAL_INVITE_REPLACE','abandon','existing_identity_transition'),
('reserve_invitation_credential_setup_v2','CREDENTIAL_SETUP','reserve','create_new_identity'),('submit_invitation_credential_setup_v2','CREDENTIAL_SETUP','submit_begin+submit_terminal','existing_identity_transition'),('status_invitation_credential_setup_v2','CREDENTIAL_SETUP','status','existing_identity_transition'),('abandon_invitation_credential_setup_v2','CREDENTIAL_SETUP','abandon','existing_identity_transition'),
('reserve_invitation_recovery_enrollment_v2','RECOVERY_ENROLLMENT','reserve','create_new_identity'),('submit_invitation_recovery_enrollment_v2','RECOVERY_ENROLLMENT','submit_begin+submit_terminal','existing_identity_transition'),('status_invitation_recovery_enrollment_v2','RECOVERY_ENROLLMENT','status','existing_identity_transition'),('abandon_invitation_recovery_enrollment_v2','RECOVERY_ENROLLMENT','abandon','existing_identity_transition'),
('reserve_invitation_recovery_rehearsal_v2','RECOVERY_REHEARSAL','reserve','create_new_identity'),('submit_invitation_recovery_rehearsal_v2','RECOVERY_REHEARSAL','submit_begin+submit_terminal','existing_identity_transition'),('status_invitation_recovery_rehearsal_v2','RECOVERY_REHEARSAL','status','existing_identity_transition'),('abandon_invitation_recovery_rehearsal_v2','RECOVERY_REHEARSAL','abandon','existing_identity_transition'),
('bind_post_signin_invitation_claim_v2','PRESENTATION_CLAIM','bind','existing_identity_transition'),('issue_invitation_review_v2','PRESENTATION_CLAIM','read_current_subject_bound_snapshot','read_only_existing_identity'),
('reserve_invitation_acceptance_v2','MEMBERSHIP_ACCEPTANCE','reserve','create_new_identity'),('submit_invitation_acceptance_v2','MEMBERSHIP_ACCEPTANCE','submit_begin+submit_terminal','existing_identity_transition'),('status_invitation_acceptance_v2','MEMBERSHIP_ACCEPTANCE','status','existing_identity_transition'),('abandon_invitation_acceptance_v2','MEMBERSHIP_ACCEPTANCE','abandon','existing_identity_transition'),
('revoke_invitation_v2','INVITE_REVOKE','atomic_submit','create_identity_binding_terminal_result_atomically'),('revoke_all_invitations_v2','INVITE_REVOKE_ALL','atomic_submit','create_identity_binding_terminal_result_atomically'),
('expire_invitation_v2','PRESENTATION_CLAIM','close:expiry','existing_claim_identities_and_invite_transition'),('compact_invitation_operation_v2',NULL,'compact','existing_identity_transition'),('classify_invitation_setup_corridor_v2',NULL,'classify','runtime_corridor_read'),('write_invitation_audit_v2',NULL,'owner_private_audit_insert','owner_private_helper_no_identity');

CREATE TABLE invitation_protocol."InvitationLineage" (
  "id" TEXT PRIMARY KEY,
  "householdId" TEXT NOT NULL REFERENCES public."Household"("id") ON DELETE CASCADE,
  "sourceInviteId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationLineage_household_id_key" UNIQUE ("householdId","id")
);
CREATE INDEX "InvitationLineage_householdId_idx" ON invitation_protocol."InvitationLineage"("householdId");

CREATE TABLE invitation_protocol."InvitationOperationIdentity" (
  "id" UUID PRIMARY KEY,
  "operationId" UUID NOT NULL UNIQUE,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "operationKind" invitation_protocol."InvitationOperationKind" NOT NULL,
  "state" invitation_protocol."InvitationOperationState" NOT NULL,
  "subjectUserId" TEXT,
  "subjectRole" public."HouseholdRole",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMP(3),
  CONSTRAINT "InvitationOperationIdentity_lineage_fkey" FOREIGN KEY ("householdId","lineageId") REFERENCES invitation_protocol."InvitationLineage"("householdId","id") ON DELETE CASCADE,
  CONSTRAINT "InvitationOperationIdentity_identity_lineage_household_key" UNIQUE ("id","householdId","lineageId"),
  CONSTRAINT "InvitationOperationIdentity_subject_projection_check" CHECK (("subjectUserId" IS NULL) = ("subjectRole" IS NULL))
);
CREATE INDEX "InvitationOperationIdentity_household_lineage_idx" ON invitation_protocol."InvitationOperationIdentity"("householdId","lineageId");
CREATE INDEX "InvitationOperationIdentity_retention_idx" ON invitation_protocol."InvitationOperationIdentity"("state","terminalAt");

CREATE TABLE invitation_protocol."InvitationPresentationClaim" (
  "identityId" UUID PRIMARY KEY,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "browserPartitionDigest" BYTEA NOT NULL,
  "tokenHashDigest" BYTEA NOT NULL,
  "subjectUserId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvitationPresentationClaim_identity_fkey" FOREIGN KEY ("identityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE,
  CONSTRAINT "InvitationPresentationClaim_digest_check" CHECK (octet_length("browserPartitionDigest")=32 AND octet_length("tokenHashDigest")=32)
);
CREATE INDEX "InvitationPresentationClaim_expiry_idx" ON invitation_protocol."InvitationPresentationClaim"("householdId","expiresAt");

CREATE TABLE invitation_protocol."InvitationOperationBinding" (
  "identityId" UUID PRIMARY KEY,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "carrierKind" TEXT NOT NULL,
  "carrierDigest" BYTEA NOT NULL,
  "ordinarySessionId" TEXT,
  "issuerMembershipEpisodeId" TEXT,
  "subjectMembershipEpisodeId" TEXT,
  "target" TEXT NOT NULL DEFAULT '',
  "openingFingerprint" BYTEA NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationOperationBinding_identity_fkey" FOREIGN KEY ("identityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE,
  CONSTRAINT "InvitationOperationBinding_digest_check" CHECK (octet_length("carrierDigest")=32 AND octet_length("openingFingerprint")=32)
);

CREATE TABLE invitation_protocol."InvitationPreparedPayload" (
  "identityId" UUID PRIMARY KEY, "householdId" TEXT NOT NULL, "lineageId" TEXT NOT NULL,
  "normalizedRecipient" TEXT NOT NULL, "offeredRole" public."HouseholdRole" NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "predecessorInviteId" TEXT, "predecessorTokenVersion" INTEGER, "target" TEXT NOT NULL,
  CONSTRAINT "InvitationPreparedPayload_identity_fkey" FOREIGN KEY ("identityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE,
  CONSTRAINT "InvitationPreparedPayload_shape_check" CHECK (("predecessorInviteId" IS NULL) = ("predecessorTokenVersion" IS NULL))
);
CREATE TABLE invitation_protocol."InvitationRequestAttestation" (
  "id" UUID PRIMARY KEY, "identityId" UUID NOT NULL, "keyVersion" INTEGER NOT NULL, "nonce" BYTEA NOT NULL UNIQUE,
  "issuedAt" TIMESTAMP(3) NOT NULL, "macDigest" BYTEA NOT NULL, "ordinarySessionId" TEXT, "subjectUserId" TEXT,
  "issuerMembershipEpisodeId" TEXT, "subjectMembershipEpisodeId" TEXT, "target" TEXT NOT NULL,
  "openingFingerprint" BYTEA, "intentFingerprint" BYTEA, "purpose" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationRequestAttestation_identity_fkey" FOREIGN KEY ("identityId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id") ON DELETE CASCADE,
  CONSTRAINT "InvitationRequestAttestation_digest_check" CHECK (octet_length("nonce")=32 AND octet_length("macDigest")=32)
);
CREATE TABLE invitation_protocol."InvitationPublicClaimAttestation" (
  "nonce" BYTEA PRIMARY KEY, "tokenHashDigest" BYTEA NOT NULL, "keyVersion" INTEGER NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL, "macDigest" BYTEA NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationPublicClaimAttestation_digest_check" CHECK (octet_length("nonce")=32 AND octet_length("tokenHashDigest")=32 AND octet_length("macDigest")=32)
);
CREATE TABLE invitation_protocol."InvitationAuditProjectionAllowlist" (
  "action" invitation_protocol.invitation_audit_action PRIMARY KEY,
  "allowedKeys" TEXT[] NOT NULL,
  CONSTRAINT "InvitationAuditProjectionAllowlist_keys_check" CHECK (cardinality("allowedKeys")>0)
);
INSERT INTO invitation_protocol."InvitationAuditProjectionAllowlist"("action","allowedKeys") VALUES
  ('invite.claim',ARRAY['outcome']),('invite.close',ARRAY['reason']),('invite.create',ARRAY['outcome']),('invite.replace',ARRAY['outcome']),
  ('credential.setup',ARRAY['outcome']),('recovery.enroll',ARRAY['outcome']),('recovery.rehearse',ARRAY['outcome']),('membership.accept',ARRAY['outcome']),
  ('invite.revoke',ARRAY['outcome']),('invite.revoke_all',ARRAY['outcome']),('invite.expire',ARRAY['outcome']),
  ('invitation.operation.compact',ARRAY['operationKind','compactedCount']);
ALTER TABLE public."Invite" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE invitation_protocol."InvitationOperationResult" (
  "identityId" UUID PRIMARY KEY,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "intentFingerprint" BYTEA,
  "status" TEXT NOT NULL CHECK ("status" IN ('pending','unknown','completed','rejected','stale')),
  "outcomeCode" TEXT,
  "safeOutcome" JSONB,
  "terminalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationOperationResult_identity_fkey" FOREIGN KEY ("identityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE,
  CONSTRAINT "InvitationOperationResult_safe_outcome_check" CHECK ("safeOutcome" IS NULL OR jsonb_typeof("safeOutcome")='object')
);

CREATE TABLE invitation_protocol."InvitationOperationTombstone" (
  "identityId" UUID PRIMARY KEY,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "class" invitation_protocol."InvitationTombstoneClass" NOT NULL,
  "operationKind" invitation_protocol."InvitationOperationKind" NOT NULL,
  "terminalCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationOperationTombstone_identity_fkey" FOREIGN KEY ("identityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE
);

CREATE TABLE invitation_protocol."InvitationAccountSetup" (
  "userId" TEXT PRIMARY KEY REFERENCES public."User"("id") ON DELETE CASCADE,
  "originLineageId" TEXT REFERENCES invitation_protocol."InvitationLineage"("id") ON DELETE SET NULL,
  "originLineageDigest" BYTEA NOT NULL,
  "setupState" TEXT NOT NULL,
  "accountOrigin" TEXT NOT NULL,
  "recoverySetVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationAccountSetup_origin_digest_check" CHECK (octet_length("originLineageDigest")=32),
  CONSTRAINT "InvitationAccountSetup_account_origin_check" CHECK ("accountOrigin" IN ('invitation_created','pre_existing'))
);
CREATE INDEX "InvitationAccountSetup_origin_lineage_idx" ON invitation_protocol."InvitationAccountSetup"("originLineageId");

CREATE TABLE invitation_protocol."InvitationRecoveryEnrollmentBridge" (
  "identityId" UUID PRIMARY KEY REFERENCES invitation_protocol."InvitationOperationIdentity"("id") ON DELETE CASCADE,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL,
  "ordinarySessionId" TEXT NOT NULL,
  "globalSecurityOperationId" TEXT NOT NULL UNIQUE CHECK ("globalSecurityOperationId" ~ '^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  "verifierBatchDigest" BYTEA CHECK ("verifierBatchDigest" IS NULL OR octet_length("verifierBatchDigest")=32),
  "intentFingerprint" BYTEA,
  "freshAuthBoundAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "InvitationRecoveryEnrollmentBridge_scope_check" CHECK (length("householdId") BETWEEN 1 AND 191 AND length("lineageId") BETWEEN 1 AND 191 AND length("subjectUserId") BETWEEN 1 AND 191 AND length("ordinarySessionId") BETWEEN 1 AND 191),
  CONSTRAINT "InvitationRecoveryEnrollmentBridge_intent_check" CHECK ("intentFingerprint" IS NULL OR octet_length("intentFingerprint")=32)
);
CREATE UNIQUE INDEX "InvitationRecoveryEnrollmentBridge_identity_scope" ON invitation_protocol."InvitationRecoveryEnrollmentBridge"("identityId","householdId","lineageId");
CREATE INDEX "InvitationRecoveryEnrollmentBridge_subject_global_idx" ON invitation_protocol."InvitationRecoveryEnrollmentBridge"("subjectUserId","globalSecurityOperationId");

CREATE TABLE invitation_protocol."InvitationSetupCorridorAttestationReceipt" (
  "nonce" BYTEA NOT NULL UNIQUE,
  "ordinarySessionId" TEXT NOT NULL REFERENCES public."Session"("id") ON DELETE CASCADE,
  "subjectUserId" TEXT NOT NULL REFERENCES public."User"("id") ON DELETE CASCADE,
  "purpose" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL REFERENCES public."FreshAuthAttestationKey"("keyVersion") ON DELETE RESTRICT,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "macDigest" BYTEA NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvitationSetupCorridorAttestationReceipt_shape_check" CHECK (octet_length("nonce")=32 AND octet_length("macDigest")=32 AND length("purpose") BETWEEN 1 AND 191)
);
CREATE INDEX "InvitationSetupCorridorAttestationReceipt_session_idx" ON invitation_protocol."InvitationSetupCorridorAttestationReceipt"("ordinarySessionId","acceptedAt");

ALTER TABLE public."RecoveryCode" ADD CONSTRAINT "RecoveryCode_user_set_id_key" UNIQUE ("userId","setVersion","id");

CREATE TABLE invitation_protocol."InvitationRecoveryRehearsalChallenge" (
  "operationIdentityId" UUID PRIMARY KEY,
  "householdId" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL REFERENCES public."User"("id") ON DELETE CASCADE,
  "ordinarySessionId" TEXT NOT NULL REFERENCES public."Session"("id") ON DELETE CASCADE,
  "credentialVersion" INTEGER NOT NULL,
  "sessionSecurityVersion" INTEGER NOT NULL,
  "recoverySetVersion" INTEGER NOT NULL,
  "selectedRecoveryCodeId" TEXT NOT NULL,
  "operationId" UUID NOT NULL UNIQUE,
  "saveAcknowledgementVersion" TEXT NOT NULL,
  "openingFingerprint" BYTEA NOT NULL,
  "nonce" BYTEA NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "state" invitation_protocol."InvitationRecoveryChallengeState" NOT NULL DEFAULT 'issued',
  "consumedAt" TIMESTAMP(3),
  "attestationKeyVersion" INTEGER,
  "attestationMacDigest" BYTEA,
  "intentFingerprint" BYTEA,
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_identity_fkey" FOREIGN KEY ("operationIdentityId","householdId","lineageId") REFERENCES invitation_protocol."InvitationOperationIdentity"("id","householdId","lineageId") ON DELETE CASCADE,
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_code_fkey" FOREIGN KEY ("subjectUserId","recoverySetVersion","selectedRecoveryCodeId") REFERENCES public."RecoveryCode"("userId","setVersion","id") ON DELETE RESTRICT,
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_set_fkey" FOREIGN KEY ("subjectUserId","recoverySetVersion") REFERENCES public."RecoveryCodeSet"("userId","setVersion") ON DELETE RESTRICT,
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_nonce_check" CHECK (octet_length("nonce")=32),
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_digest_check" CHECK (octet_length("openingFingerprint")=32 AND ("attestationMacDigest" IS NULL OR octet_length("attestationMacDigest")=32) AND ("intentFingerprint" IS NULL OR octet_length("intentFingerprint")=32)),
  CONSTRAINT "InvitationRecoveryRehearsalChallenge_state_check" CHECK (("state"='issued' AND "consumedAt" IS NULL AND "attestationKeyVersion" IS NULL AND "attestationMacDigest" IS NULL AND "intentFingerprint" IS NULL) OR ("state" IN ('consumed','expired') AND "consumedAt" IS NOT NULL))
);
CREATE INDEX "InvitationRecoveryRehearsalChallenge_subject_set_idx" ON invitation_protocol."InvitationRecoveryRehearsalChallenge"("subjectUserId","recoverySetVersion");

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationIdentity_immutability_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF NEW."id"<>OLD."id" OR NEW."operationId"<>OLD."operationId" OR NEW."householdId"<>OLD."householdId" OR NEW."lineageId"<>OLD."lineageId" OR NEW."operationKind"<>OLD."operationKind" OR NEW."createdAt"<>OLD."createdAt" THEN RAISE EXCEPTION 'invitation_identity_immutable'; END IF;
  IF OLD."subjectUserId" IS NOT NULL AND (NEW."subjectUserId" IS DISTINCT FROM OLD."subjectUserId" OR NEW."subjectRole" IS DISTINCT FROM OLD."subjectRole") THEN RAISE EXCEPTION 'invitation_subject_projection_write_once'; END IF;
  IF (OLD."subjectUserId" IS NULL) <> (NEW."subjectUserId" IS NULL) AND NEW."state"<>'PRESENTATION_SUBJECT_BOUND' THEN RAISE EXCEPTION 'invitation_subject_projection_invalid'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationPresentationClaim_binding_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW."identityId"<>OLD."identityId" OR NEW."householdId"<>OLD."householdId" OR NEW."lineageId"<>OLD."lineageId" OR NEW."browserPartitionDigest"<>OLD."browserPartitionDigest" OR NEW."tokenHashDigest"<>OLD."tokenHashDigest" OR NEW."expiresAt"<>OLD."expiresAt" THEN RAISE EXCEPTION 'invitation_claim_binding_immutable'; END IF;
  IF OLD."subjectUserId" IS NOT NULL OR NEW."subjectUserId" IS NULL THEN RAISE EXCEPTION 'invitation_claim_subject_write_once'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationBinding_immutability_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'invitation_binding_immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationResult_immutability_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD."terminalAt" IS NOT NULL OR OLD."status" IN ('completed','rejected','stale') THEN RAISE EXCEPTION 'invitation_terminal_result_immutable'; END IF;
  IF NEW."identityId"<>OLD."identityId" OR NEW."householdId"<>OLD."householdId" OR NEW."lineageId"<>OLD."lineageId" OR NEW."createdAt"<>OLD."createdAt" OR NEW."intentFingerprint" IS DISTINCT FROM OLD."intentFingerprint" THEN RAISE EXCEPTION 'invitation_result_binding_immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationTombstone_immutability_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN RAISE EXCEPTION 'invitation_tombstone_immutable'; END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationAccountSetup_origin_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF NEW."userId"<>OLD."userId" OR NEW."originLineageDigest"<>OLD."originLineageDigest" OR NEW."createdAt"<>OLD."createdAt" OR NEW."accountOrigin"<>OLD."accountOrigin" THEN RAISE EXCEPTION 'invitation_account_origin_immutable'; END IF;
  IF OLD."originLineageId" IS NULL AND NEW."originLineageId" IS NOT NULL THEN RAISE EXCEPTION 'invitation_account_origin_no_rebind'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationRecoveryRehearsalChallenge_binding_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW."operationIdentityId"<>OLD."operationIdentityId" OR NEW."householdId"<>OLD."householdId" OR NEW."lineageId"<>OLD."lineageId" OR NEW."subjectUserId"<>OLD."subjectUserId" OR NEW."ordinarySessionId"<>OLD."ordinarySessionId" OR NEW."credentialVersion"<>OLD."credentialVersion" OR NEW."sessionSecurityVersion"<>OLD."sessionSecurityVersion" OR NEW."recoverySetVersion"<>OLD."recoverySetVersion" OR NEW."selectedRecoveryCodeId"<>OLD."selectedRecoveryCodeId" OR NEW."operationId"<>OLD."operationId" OR NEW."saveAcknowledgementVersion"<>OLD."saveAcknowledgementVersion" OR NEW."openingFingerprint"<>OLD."openingFingerprint" OR NEW."nonce"<>OLD."nonce" OR NEW."expiresAt"<>OLD."expiresAt" THEN RAISE EXCEPTION 'invitation_rehearsal_challenge_binding_immutable'; END IF;
  IF OLD."state"<>'issued' OR NEW."state" NOT IN ('consumed','expired') OR NEW."consumedAt" IS NULL THEN RAISE EXCEPTION 'invitation_rehearsal_challenge_one_time'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_count INTEGER; binding_count INTEGER; result_count INTEGER; tombstone_count INTEGER; terminal_result BOOLEAN;
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=COALESCE((to_jsonb(NEW)->>'id')::UUID,(to_jsonb(OLD)->>'id')::UUID,(to_jsonb(NEW)->>'identityId')::UUID,(to_jsonb(OLD)->>'identityId')::UUID);
  IF identity_row."id" IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO claim_count FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id";
  SELECT count(*) INTO binding_count FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id";
  SELECT count(*) INTO result_count FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id";
  SELECT count(*) INTO tombstone_count FROM invitation_protocol."InvitationOperationTombstone" WHERE "identityId"=identity_row."id";
  SELECT EXISTS (SELECT 1 FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" AND ("terminalAt" IS NOT NULL OR "status" IN ('completed','rejected','stale'))) INTO terminal_result;
  IF claim_count>1 OR binding_count>1 OR result_count>1 OR tombstone_count>1 OR (tombstone_count=1 AND (claim_count<>0 OR binding_count<>0 OR result_count<>0)) OR (result_count=1 AND binding_count<>1) THEN RAISE EXCEPTION 'invitation_operation_peer_occupancy_invalid'; END IF;
  IF identity_row."operationKind"='PRESENTATION_CLAIM' AND NOT ((identity_row."state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') AND claim_count=1 AND binding_count=0 AND result_count=0 AND tombstone_count=0) OR (identity_row."state"='PRESENTATION_CLOSED' AND claim_count=0 AND binding_count=0 AND result_count=0 AND tombstone_count=1)) THEN RAISE EXCEPTION 'invitation_presentation_occupancy_invalid'; END IF;
  IF identity_row."operationKind"<>'PRESENTATION_CLAIM' AND NOT ((identity_row."state"='PREPARED' AND binding_count=1 AND result_count=0 AND tombstone_count=0) OR (identity_row."state"='SUBMITTED' AND binding_count=1 AND result_count=1 AND NOT terminal_result AND tombstone_count=0) OR (identity_row."state"='TERMINAL_FULL' AND binding_count=1 AND result_count=1 AND terminal_result AND tombstone_count=0) OR (identity_row."state"='COMPACTED' AND binding_count=0 AND result_count=0 AND tombstone_count=1) OR (identity_row."state"='ABANDONED' AND binding_count=0 AND result_count=0 AND tombstone_count=1)) THEN RAISE EXCEPTION 'invitation_operation_occupancy_invalid'; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "InvitationOperationIdentity_identity_guard" BEFORE UPDATE ON invitation_protocol."InvitationOperationIdentity" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_immutability_guard"();
CREATE TRIGGER "InvitationPresentationClaim_binding_guard" BEFORE UPDATE OR DELETE ON invitation_protocol."InvitationPresentationClaim" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationPresentationClaim_binding_guard"();
CREATE TRIGGER "InvitationOperationBinding_binding_guard" BEFORE UPDATE ON invitation_protocol."InvitationOperationBinding" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationBinding_immutability_guard"();
CREATE TRIGGER "InvitationOperationResult_result_guard" BEFORE UPDATE OR DELETE ON invitation_protocol."InvitationOperationResult" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationResult_immutability_guard"();
CREATE TRIGGER "InvitationOperationTombstone_tombstone_guard" BEFORE UPDATE OR DELETE ON invitation_protocol."InvitationOperationTombstone" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationTombstone_immutability_guard"();
CREATE TRIGGER "InvitationAccountSetup_origin_guard" BEFORE UPDATE ON invitation_protocol."InvitationAccountSetup" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationAccountSetup_origin_guard"();
CREATE TRIGGER "InvitationRecoveryRehearsalChallenge_binding_guard" BEFORE UPDATE OR DELETE ON invitation_protocol."InvitationRecoveryRehearsalChallenge" FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationRecoveryRehearsalChallenge_binding_guard"();
CREATE CONSTRAINT TRIGGER "InvitationOperationIdentity_occupancy_guard" AFTER INSERT OR UPDATE OR DELETE ON invitation_protocol."InvitationOperationIdentity" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"();
CREATE CONSTRAINT TRIGGER "InvitationPresentationClaim_occupancy_guard" AFTER INSERT OR UPDATE OR DELETE ON invitation_protocol."InvitationPresentationClaim" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"();
CREATE CONSTRAINT TRIGGER "InvitationOperationBinding_occupancy_guard" AFTER INSERT OR UPDATE OR DELETE ON invitation_protocol."InvitationOperationBinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"();
CREATE CONSTRAINT TRIGGER "InvitationOperationResult_occupancy_guard" AFTER INSERT OR UPDATE OR DELETE ON invitation_protocol."InvitationOperationResult" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"();
CREATE CONSTRAINT TRIGGER "InvitationOperationTombstone_occupancy_guard" AFTER INSERT OR UPDATE OR DELETE ON invitation_protocol."InvitationOperationTombstone" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"();

CREATE OR REPLACE FUNCTION invitation_protocol.invitation_safe_receipt(scope_operation_id UUID, scope_status TEXT, scope_code TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$ SELECT jsonb_strip_nulls(jsonb_build_object('operationId',scope_operation_id,'status',scope_status,'outcomeCode',scope_code,'terminalAt',clock_timestamp())) $$;

CREATE OR REPLACE FUNCTION invitation_protocol.verify_invitation_recovery_rehearsal_attestation_v1(scope_subject_user_id TEXT, scope_ordinary_session_id TEXT, scope_operation_identity_id UUID, scope_operation_id UUID, scope_credential_version INTEGER, scope_session_security_version INTEGER, scope_recovery_set_version INTEGER, scope_selected_recovery_code_id TEXT, scope_nonce BYTEA, scope_key_version INTEGER, scope_opening_fingerprint BYTEA, scope_intent_fingerprint BYTEA, scope_mac BYTEA)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE key_row public."FreshAuthAttestationKey"%ROWTYPE; payload BYTEA:=convert_to('invitation-recovery-rehearsal-attestation-v1','UTF8');
BEGIN
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_key_version AND "active"=true AND ("rotatedAt" IS NULL OR "rotatedAt">clock_timestamp()-INTERVAL '10 minutes');
  IF key_row."keyVersion" IS NULL OR octet_length(scope_nonce)<>32 OR octet_length(scope_opening_fingerprint)<>32 OR octet_length(scope_intent_fingerprint)<>32 OR octet_length(scope_mac)<>32 THEN RETURN false; END IF;
  payload:=payload||int4send(octet_length(convert_to(scope_subject_user_id,'UTF8')))||convert_to(scope_subject_user_id,'UTF8')||int4send(octet_length(convert_to(scope_ordinary_session_id,'UTF8')))||convert_to(scope_ordinary_session_id,'UTF8')||convert_to('RECOVERY_REHEARSAL','UTF8')||uuid_send(scope_operation_identity_id)||uuid_send(scope_operation_id)||int4send(scope_credential_version)||int4send(scope_session_security_version)||int4send(scope_recovery_set_version)||int4send(octet_length(convert_to(scope_selected_recovery_code_id,'UTF8')))||convert_to(scope_selected_recovery_code_id,'UTF8')||scope_nonce||int4send(scope_key_version)||scope_opening_fingerprint||scope_intent_fingerprint;
  RETURN public.hmac(payload,key_row."verificationKey",'sha256')=scope_mac;
END $$;

-- Canonical Global Security operations take this transition lock before any row lock. Invitation
-- bridge paths row-lock the same canonical state, so they must take it first and in the same order.
CREATE OR REPLACE FUNCTION invitation_protocol.lock_global_security_transition_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.lock_invitation_protocol_v2(scope_household_id TEXT, scope_operation_id UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF scope_operation_id IS NULL THEN RAISE EXCEPTION 'invitation_lock_input_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_operation_id::TEXT,0));
  IF scope_household_id IS NULL THEN RAISE EXCEPTION 'invitation_lock_input_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_household_id,0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.lock_invitation_operation_v2(scope_operation_id UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF scope_operation_id IS NULL THEN RAISE EXCEPTION 'invitation_lock_input_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_operation_id::TEXT,0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.lock_invitation_claim_v2(scope_token_digest BYTEA) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF octet_length(scope_token_digest)<>32 THEN RAISE EXCEPTION 'invitation_lock_input_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(encode(scope_token_digest,'hex'),0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.lock_invitation_household_v2(scope_household_id TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF scope_household_id IS NULL THEN RAISE EXCEPTION 'invitation_lock_input_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_household_id,0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.create_invitation_identity_v2(scope_operation_id UUID, scope_household_id TEXT, scope_kind invitation_protocol."InvitationOperationKind", scope_state invitation_protocol."InvitationOperationState", scope_source_invite_id TEXT DEFAULT NULL) RETURNS invitation_protocol."InvitationOperationIdentity" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE lineage_id TEXT; created invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  SELECT "id" INTO lineage_id FROM invitation_protocol."InvitationLineage" WHERE "householdId"=scope_household_id AND "sourceInviteId" IS NOT DISTINCT FROM scope_source_invite_id FOR UPDATE;
  IF lineage_id IS NULL THEN lineage_id:='inl_'||encode(public.gen_random_bytes(16),'hex'); INSERT INTO invitation_protocol."InvitationLineage"("id","householdId","sourceInviteId") VALUES(lineage_id,scope_household_id,scope_source_invite_id); END IF;
  INSERT INTO invitation_protocol."InvitationOperationIdentity"("id","operationId","householdId","lineageId","operationKind","state") VALUES(gen_random_uuid(),scope_operation_id,scope_household_id,lineage_id,scope_kind,scope_state) RETURNING * INTO created;
  RETURN created;
EXCEPTION WHEN unique_violation THEN SELECT * INTO created FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=scope_operation_id FOR UPDATE; IF NOT FOUND OR created."householdId"<>scope_household_id OR created."operationKind"<>scope_kind THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN created;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.write_invitation_binding_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_carrier_kind TEXT, scope_carrier_digest BYTEA, scope_opening BYTEA, scope_session_id TEXT DEFAULT NULL, scope_issuer_member_id TEXT DEFAULT NULL, scope_subject_member_id TEXT DEFAULT NULL, scope_target TEXT DEFAULT '') RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF octet_length(scope_carrier_digest)<>32 OR octet_length(scope_opening)<>32 THEN RAISE EXCEPTION 'invitation_binding_digest_invalid'; END IF;
  INSERT INTO invitation_protocol."InvitationOperationBinding"("identityId","householdId","lineageId","carrierKind","carrierDigest","openingFingerprint","expiresAt","ordinarySessionId","issuerMembershipEpisodeId","subjectMembershipEpisodeId","target") VALUES(scope_identity."id",scope_identity."householdId",scope_identity."lineageId",scope_carrier_kind,scope_carrier_digest,scope_opening,clock_timestamp()+INTERVAL '20 minutes',scope_session_id,scope_issuer_member_id,scope_subject_member_id,scope_target) ON CONFLICT("identityId") DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reauthorize_invitation_carrier_v2(scope_identity_id UUID, scope_operation_id UUID, scope_kind invitation_protocol."InvitationOperationKind", scope_attestation invitation_protocol.invitation_request_attestation) RETURNS invitation_protocol."InvitationOperationIdentity" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; key_row public."FreshAuthAttestationKey"%ROWTYPE; prior invitation_protocol."InvitationRequestAttestation"%ROWTYPE; payload BYTEA:=convert_to('cubby.invitation.request-attestation.v1','UTF8');
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=scope_identity_id AND "operationId"=scope_operation_id AND "operationKind"=scope_kind FOR UPDATE;
  IF NOT FOUND OR (scope_attestation).operation_id<>scope_operation_id OR (scope_attestation).operation_kind<>scope_kind OR octet_length((scope_attestation).nonce)<>32 OR octet_length((scope_attestation).mac)<>32 OR octet_length((scope_attestation).opening_fingerprint)<>32 OR (scope_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (scope_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' THEN RAISE EXCEPTION 'invitation_carrier_invalid'; END IF;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=(scope_attestation).key_version AND ("active" OR "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_attestation_key_invalid'; END IF;
  payload:=payload||int4send(octet_length(convert_to(COALESCE((scope_attestation).ordinary_session_id,''),'UTF8')))||convert_to(COALESCE((scope_attestation).ordinary_session_id,''),'UTF8')||int4send(octet_length(convert_to(COALESCE((scope_attestation).subject_user_id,''),'UTF8')))||convert_to(COALESCE((scope_attestation).subject_user_id,''),'UTF8')||int4send(octet_length(convert_to(COALESCE((scope_attestation).issuer_membership_episode_id,''),'UTF8')))||convert_to(COALESCE((scope_attestation).issuer_membership_episode_id,''),'UTF8')||int4send(octet_length(convert_to(COALESCE((scope_attestation).subject_membership_episode_id,''),'UTF8')))||convert_to(COALESCE((scope_attestation).subject_membership_episode_id,''),'UTF8')||convert_to(scope_kind::TEXT,'UTF8')||uuid_send(scope_operation_id)||int4send(octet_length(convert_to(COALESCE((scope_attestation).target,''),'UTF8')))||convert_to(COALESCE((scope_attestation).target,''),'UTF8')||(scope_attestation).opening_fingerprint||COALESCE((scope_attestation).intent_fingerprint,''::BYTEA)||int4send(octet_length(convert_to(COALESCE((scope_attestation).purpose,''),'UTF8')))||convert_to(COALESCE((scope_attestation).purpose,''),'UTF8')||(scope_attestation).nonce||int4send((scope_attestation).key_version);
  IF scope_kind='RECOVERY_ENROLLMENT' AND (scope_attestation).purpose='recovery_enrollment_submit' THEN
    IF (scope_attestation).target IS NULL OR (scope_attestation).target !~ '^recovery-v1:[1-9][0-9]{0,8}:[1-9][0-9]{0,8}:[1-9][0-9]{0,8}:[0-9a-f]{64}$' OR (scope_attestation).subject_user_id IS NULL OR (scope_attestation).ordinary_session_id IS NULL OR (scope_attestation).issuer_membership_episode_id IS NOT NULL OR (scope_attestation).subject_membership_episode_id IS NOT NULL OR octet_length((scope_attestation).intent_fingerprint) IS DISTINCT FROM 32 THEN RAISE EXCEPTION 'invitation_carrier_invalid'; END IF;
    payload:=convert_to('cubby.invitation.recovery-enrollment-attestation.v1','UTF8')||int4send(octet_length(convert_to((scope_attestation).subject_user_id,'UTF8')))||convert_to((scope_attestation).subject_user_id,'UTF8')||int4send(octet_length(convert_to((scope_attestation).ordinary_session_id,'UTF8')))||convert_to((scope_attestation).ordinary_session_id,'UTF8')||convert_to('RECOVERY_ENROLLMENT','UTF8')||uuid_send(scope_operation_id)||int4send(split_part((scope_attestation).target,':',2)::INTEGER)||int4send(split_part((scope_attestation).target,':',3)::INTEGER)||int4send(split_part((scope_attestation).target,':',4)::INTEGER)||(scope_attestation).opening_fingerprint||(scope_attestation).intent_fingerprint||decode(split_part((scope_attestation).target,':',5),'hex')||(scope_attestation).nonce||int4send((scope_attestation).key_version);
  END IF;
  IF public.hmac(payload,key_row."verificationKey",'sha256') IS DISTINCT FROM (scope_attestation).mac THEN RAISE EXCEPTION 'invitation_attestation_mac_invalid'; END IF;
  IF (scope_attestation).ordinary_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."Session" s JOIN public."User" u ON u."id"=s."userId" WHERE s."id"=(scope_attestation).ordinary_session_id AND s."userId"=(scope_attestation).subject_user_id AND s."expiresAt">clock_timestamp() FOR UPDATE OF s,u) THEN RAISE EXCEPTION 'invitation_session_invalid'; END IF;
  IF (scope_attestation).issuer_membership_episode_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."HouseholdMember" m WHERE m."id"=(scope_attestation).issuer_membership_episode_id AND m."householdId"=identity_row."householdId" AND m."userId"=(scope_attestation).subject_user_id AND m."disabledAt" IS NULL AND m."deletedAt" IS NULL FOR UPDATE) THEN RAISE EXCEPTION 'invitation_membership_invalid'; END IF;
  IF (scope_attestation).subject_membership_episode_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."HouseholdMember" m WHERE m."id"=(scope_attestation).subject_membership_episode_id AND m."householdId"=identity_row."householdId" AND m."userId"=(scope_attestation).subject_user_id AND m."disabledAt" IS NULL AND m."deletedAt" IS NULL FOR UPDATE) THEN RAISE EXCEPTION 'invitation_subject_membership_invalid'; END IF;
  SELECT * INTO prior FROM invitation_protocol."InvitationRequestAttestation" WHERE "nonce"=(scope_attestation).nonce FOR UPDATE;
  IF FOUND THEN IF prior."identityId"<>scope_identity_id OR prior."keyVersion"<>(scope_attestation).key_version OR prior."ordinarySessionId" IS DISTINCT FROM (scope_attestation).ordinary_session_id OR prior."subjectUserId" IS DISTINCT FROM (scope_attestation).subject_user_id OR prior."issuerMembershipEpisodeId" IS DISTINCT FROM (scope_attestation).issuer_membership_episode_id OR prior."subjectMembershipEpisodeId" IS DISTINCT FROM (scope_attestation).subject_membership_episode_id OR prior."target"<>COALESCE((scope_attestation).target,'') OR prior."openingFingerprint" IS DISTINCT FROM (scope_attestation).opening_fingerprint OR prior."intentFingerprint" IS DISTINCT FROM (scope_attestation).intent_fingerprint OR prior."purpose" IS DISTINCT FROM (scope_attestation).purpose OR prior."macDigest"<>public.digest((scope_attestation).mac,'sha256') THEN RAISE EXCEPTION 'invitation_attestation_replay_conflict'; END IF; ELSE INSERT INTO invitation_protocol."InvitationRequestAttestation"("id","identityId","keyVersion","nonce","issuedAt","macDigest","ordinarySessionId","subjectUserId","issuerMembershipEpisodeId","subjectMembershipEpisodeId","target","openingFingerprint","intentFingerprint","purpose") VALUES(gen_random_uuid(),scope_identity_id,(scope_attestation).key_version,(scope_attestation).nonce,(scope_attestation).issued_at,public.digest((scope_attestation).mac,'sha256'),(scope_attestation).ordinary_session_id,(scope_attestation).subject_user_id,(scope_attestation).issuer_membership_episode_id,(scope_attestation).subject_membership_episode_id,COALESCE((scope_attestation).target,''),(scope_attestation).opening_fingerprint,(scope_attestation).intent_fingerprint,(scope_attestation).purpose); END IF;
  RETURN identity_row;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reauthorize_invitation_public_claim_carrier_v2(scope_token_digest BYTEA, scope_attestation invitation_protocol.invitation_public_token_claim) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE key_row public."FreshAuthAttestationKey"%ROWTYPE; payload BYTEA:=convert_to('cubby.invitation.public-claim.v1','UTF8');
BEGIN
  IF octet_length(scope_token_digest)<>32 OR (scope_attestation).token_hash_digest IS DISTINCT FROM scope_token_digest OR (scope_attestation).key_version IS NULL OR octet_length((scope_attestation).nonce)<>32 OR octet_length((scope_attestation).mac)<>32 OR (scope_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (scope_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' THEN RAISE EXCEPTION 'invitation_claim_denied'; END IF;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=(scope_attestation).key_version AND ("active" OR "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes') FOR SHARE;
  payload:=payload||scope_token_digest||(scope_attestation).nonce||int4send((scope_attestation).key_version);
  IF key_row."keyVersion" IS NULL OR public.hmac(payload,key_row."verificationKey",'sha256')<>(scope_attestation).mac THEN RAISE EXCEPTION 'invitation_claim_denied'; END IF;
  INSERT INTO invitation_protocol."InvitationPublicClaimAttestation"("nonce","tokenHashDigest","keyVersion","issuedAt","macDigest") VALUES((scope_attestation).nonce,scope_token_digest,(scope_attestation).key_version,(scope_attestation).issued_at,public.digest((scope_attestation).mac,'sha256')) ON CONFLICT("nonce") DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_claim_denied'; END IF;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.write_invitation_terminal_result_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_intent BYTEA, scope_code TEXT, scope_outcome JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN IF octet_length(scope_intent)<>32 OR jsonb_typeof(scope_outcome)<>'object' THEN RAISE EXCEPTION 'invitation_terminal_result_invalid'; END IF; INSERT INTO invitation_protocol."InvitationOperationResult"("identityId","householdId","lineageId","intentFingerprint","status","outcomeCode","safeOutcome","terminalAt") VALUES(scope_identity."id",scope_identity."householdId",scope_identity."lineageId",scope_intent,'completed',scope_code,scope_outcome,clock_timestamp()) ON CONFLICT("identityId") DO NOTHING; UPDATE invitation_protocol."InvitationOperationIdentity" SET "state"='TERMINAL_FULL',"terminalAt"=clock_timestamp() WHERE "id"=scope_identity."id" AND "state" IN ('PREPARED','SUBMITTED'); END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.write_invitation_tombstone_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_class invitation_protocol."InvitationTombstoneClass", scope_code TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN INSERT INTO invitation_protocol."InvitationOperationTombstone"("identityId","householdId","lineageId","class","operationKind","terminalCode") VALUES(scope_identity."id",scope_identity."householdId",scope_identity."lineageId",scope_class,scope_identity."operationKind",scope_code) ON CONFLICT("identityId") DO NOTHING; UPDATE invitation_protocol."InvitationOperationIdentity" SET "state"=(CASE WHEN scope_class='FULL_COMPACTION' THEN 'COMPACTED' WHEN scope_identity."operationKind"='PRESENTATION_CLAIM' THEN 'PRESENTATION_CLOSED' ELSE 'ABANDONED' END)::invitation_protocol."InvitationOperationState","terminalAt"=clock_timestamp() WHERE "id"=scope_identity."id"; END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.execute_invitation_domain_transition_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_transition TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$ BEGIN IF scope_transition IN ('manual_create','manual_replace') THEN DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=scope_identity."id"; END IF; RETURN jsonb_build_object('operationId',scope_identity."operationId",'state','completed'); END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.lock_invitation_recipient_v2(scope_household_id TEXT, scope_recipient TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF scope_household_id IS NULL OR scope_recipient IS NULL OR lower(btrim(scope_recipient))='' THEN RAISE EXCEPTION 'invitation_reservation_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_household_id||':'||lower(btrim(scope_recipient)),0));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.assert_invitation_issuer_authority_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_attestation invitation_protocol.invitation_request_attestation, scope_offered_role public."HouseholdRole" DEFAULT NULL, scope_require_owner BOOLEAN DEFAULT false, scope_expected_purpose TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; member_row public."HouseholdMember"%ROWTYPE;
BEGIN
  SELECT * INTO session_row FROM public."Session" WHERE "id"=(scope_attestation).ordinary_session_id AND "userId"=(scope_attestation).subject_user_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=(scope_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO member_row FROM public."HouseholdMember" WHERE "id"=(scope_attestation).issuer_membership_episode_id AND "householdId"=scope_identity."householdId" AND "userId"=(scope_attestation).subject_user_id AND "disabledAt" IS NULL AND "deletedAt" IS NULL FOR UPDATE;
  SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=scope_identity."id" FOR UPDATE;
  IF session_row."id" IS NULL OR user_row."id" IS NULL OR member_row."id" IS NULL OR (scope_expected_purpose IS NOT NULL AND (scope_attestation).purpose<>scope_expected_purpose) THEN RAISE EXCEPTION 'invitation_issuer_forbidden'; END IF;
  IF binding_row."identityId" IS NOT NULL AND (binding_row."ordinarySessionId" IS DISTINCT FROM (scope_attestation).ordinary_session_id OR binding_row."issuerMembershipEpisodeId" IS DISTINCT FROM (scope_attestation).issuer_membership_episode_id OR binding_row."target"<>COALESCE((scope_attestation).target,'') OR binding_row."openingFingerprint" IS DISTINCT FROM (scope_attestation).opening_fingerprint OR binding_row."expiresAt"<=clock_timestamp()) THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  IF scope_require_owner AND member_row."role"<>'owner' THEN RAISE EXCEPTION 'invitation_issuer_forbidden'; END IF;
  IF scope_offered_role IS NULL THEN
    IF member_row."role" NOT IN ('owner','admin') THEN RAISE EXCEPTION 'invitation_issuer_forbidden'; END IF;
  ELSIF scope_offered_role='owner' OR (scope_offered_role='admin' AND member_row."role"<>'owner') OR (scope_offered_role IN ('parent','caretaker','read_only') AND member_row."role" NOT IN ('owner','admin')) THEN
    RAISE EXCEPTION 'invitation_issuer_forbidden';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.claim_invitation_presentation_v2(raw_fragment_token TEXT, browser_partition_digest BYTEA, public_claim_attestation invitation_protocol.invitation_public_token_claim) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE invite_row public."Invite"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; token_digest BYTEA:=public.digest(convert_to(COALESCE(raw_fragment_token,''),'UTF8'),'sha256');
BEGIN
  IF raw_fragment_token IS NULL OR raw_fragment_token='' OR octet_length(browser_partition_digest)<>32 OR (public_claim_attestation).token_hash_digest<>token_digest THEN RAISE EXCEPTION 'invitation_claim_denied'; END IF;
  PERFORM invitation_protocol.lock_invitation_claim_v2(token_digest);
  SELECT * INTO invite_row FROM public."Invite" WHERE "tokenHash"=encode(token_digest,'hex') AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(invite_row."householdId",gen_random_uuid());
  PERFORM invitation_protocol.reauthorize_invitation_public_claim_carrier_v2(token_digest,public_claim_attestation);
  PERFORM 1 FROM invitation_protocol."InvitationLineage" WHERE "householdId"=invite_row."householdId" AND "sourceInviteId"=invite_row."id" FOR UPDATE;
  identity_row:=invitation_protocol.create_invitation_identity_v2(gen_random_uuid(),invite_row."householdId",'PRESENTATION_CLAIM','PRESENTATION_OPEN',invite_row."id");
  INSERT INTO invitation_protocol."InvitationPresentationClaim"("identityId","householdId","lineageId","browserPartitionDigest","tokenHashDigest","expiresAt") VALUES(identity_row."id",identity_row."householdId",identity_row."lineageId",browser_partition_digest,token_digest,invite_row."expiresAt");
  PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.claim',jsonb_build_object('outcome','claimed'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('claimIdentityId',identity_row."id",'operationId',identity_row."operationId",'status','claimed');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','unavailable');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.close_invitation_presentation_v2(claim_identity_id UUID, reason invitation_protocol.presentation_close_reason, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2((request_attestation).operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",identity_row."operationId");
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id" AND "householdId"=identity_row."householdId" AND "lineageId"=identity_row."lineageId" FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=identity_row."lineageId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=(request_attestation).ordinary_session_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE;
  IF identity_row."state" NOT IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') OR claim_row."identityId" IS NULL OR invite_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR (request_attestation).subject_user_id<>user_row."id" THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",identity_row."operationId",'PRESENTATION_CLAIM',request_attestation);
  DELETE FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id";
  PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE',reason::TEXT);
  PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.close',jsonb_build_object('reason',reason::TEXT),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',identity_row."operationId",'status','closed');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','unavailable');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.reserve_manual_invite_create_v2(operation_id UUID, household_id TEXT, role public."HouseholdRole", expires_in_hours INTEGER, recipient_email TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; payload invitation_protocol."InvitationPreparedPayload"%ROWTYPE; normalized_email TEXT:=lower(btrim(recipient_email));
BEGIN
  IF operation_id IS NULL OR household_id IS NULL OR role='owner' OR expires_in_hours NOT BETWEEN 1 AND 720 OR octet_length(opening_fingerprint)<>32 OR normalized_email='' OR (request_attestation).target<>household_id THEN RAISE EXCEPTION 'invitation_reservation_invalid'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(household_id,operation_id); PERFORM invitation_protocol.lock_invitation_recipient_v2(household_id,normalized_email);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id FOR UPDATE;
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,household_id,'MANUAL_INVITE_CREATE','PREPARED');
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'issuer_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),opening_fingerprint,(request_attestation).ordinary_session_id,(request_attestation).issuer_membership_episode_id,NULL,household_id);
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_CREATE',request_attestation);
  PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,role,false,'manual_invite_create');
  SELECT * INTO payload FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF FOUND AND (identity_row."state"<>'PREPARED' OR payload."normalizedRecipient"<>normalized_email OR payload."offeredRole"<>role OR payload."expiresAt"<>identity_row."createdAt"+make_interval(hours=>expires_in_hours) OR payload."predecessorInviteId" IS NOT NULL OR payload."target"<>household_id) THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  INSERT INTO invitation_protocol."InvitationPreparedPayload"("identityId","householdId","lineageId","normalizedRecipient","offeredRole","expiresAt","predecessorInviteId","predecessorTokenVersion","target") VALUES(identity_row."id",household_id,identity_row."lineageId",normalized_email,role,identity_row."createdAt"+make_interval(hours=>expires_in_hours),NULL,NULL,household_id) ON CONFLICT("identityId") DO NOTHING;
  RETURN jsonb_build_object('operationId',operation_id,'status','prepared');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.submit_manual_invite_create_v2(operation_id UUID, intent_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; payload invitation_protocol."InvitationPreparedPayload"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; authorization_role public."HouseholdRole"; raw_token TEXT; invite_id TEXT;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_CREATE' FOR UPDATE;
  IF NOT FOUND OR octet_length(intent_fingerprint)<>32 OR (request_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id);
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_CREATE',request_attestation);
  SELECT * INTO payload FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id" FOR UPDATE; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  authorization_role:=CASE WHEN identity_row."state"='TERMINAL_FULL' THEN (result_row."safeOutcome"->>'offeredRole')::public."HouseholdRole" ELSE payload."offeredRole" END;
  PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,authorization_role,false,'manual_invite_create');
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome")); END IF;
  IF payload."identityId" IS NULL OR identity_row."state"<>'PREPARED' OR payload."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_recipient_v2(payload."householdId",payload."normalizedRecipient");
  raw_token:=translate(rtrim(encode(public.gen_random_bytes(32),'base64'),'='),'+/','-_'); invite_id:='inv_'||encode(public.gen_random_bytes(16),'hex');
  INSERT INTO public."Invite"("id","householdId","email","role","tokenHash","status","invitedByUserId","expiresAt","updatedAt") VALUES(invite_id,payload."householdId",payload."normalizedRecipient",payload."offeredRole",encode(public.digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),'pending',(request_attestation).subject_user_id,payload."expiresAt",clock_timestamp());
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'manual_create');
  DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id";
  PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'invite_created',jsonb_build_object('expiresAt',payload."expiresAt",'offeredRole',payload."offeredRole"));
  PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.create',jsonb_build_object('outcome','created'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',operation_id,'inviteToken',raw_token,'status','created');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.status_manual_invite_create_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_CREATE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_unknown'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_CREATE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,NULL,false,'manual_invite_status');
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'state',identity_row."state",'outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome"));
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.abandon_manual_invite_create_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_CREATE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_unknown'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_CREATE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,NULL,false,'manual_invite_abandon');
  IF identity_row."state"='ABANDONED' THEN RETURN jsonb_build_object('operationId',operation_id,'status','abandoned'); END IF;
  IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id";
  PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.create',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',operation_id,'status','abandoned');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.reserve_manual_invite_replace_v2(operation_id UUID, expires_in_hours INTEGER, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; predecessor public."Invite"%ROWTYPE; payload invitation_protocol."InvitationPreparedPayload"%ROWTYPE;
BEGIN
  IF operation_id IS NULL OR expires_in_hours NOT BETWEEN 1 AND 720 OR octet_length(opening_fingerprint)<>32 OR (request_attestation).target IS NULL THEN RAISE EXCEPTION 'invitation_reservation_invalid'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO predecessor FROM public."Invite" WHERE "id"=(request_attestation).target FOR UPDATE; IF NOT FOUND OR predecessor."status"<>'pending' OR predecessor."expiresAt"<=clock_timestamp() OR predecessor."role"='owner' THEN RAISE EXCEPTION 'invitation_predecessor_missing'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(predecessor."householdId",operation_id); PERFORM invitation_protocol.lock_invitation_recipient_v2(predecessor."householdId",predecessor."email");
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id FOR UPDATE;
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,predecessor."householdId",'MANUAL_INVITE_REPLACE','PREPARED',predecessor."id");
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'issuer_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),opening_fingerprint,(request_attestation).ordinary_session_id,(request_attestation).issuer_membership_episode_id,NULL,predecessor."id");
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_REPLACE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,predecessor."role",false,'manual_invite_replace');
  SELECT * INTO payload FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF FOUND AND (identity_row."state"<>'PREPARED' OR payload."normalizedRecipient"<>lower(btrim(predecessor."email")) OR payload."offeredRole"<>predecessor."role" OR payload."expiresAt"<>identity_row."createdAt"+make_interval(hours=>expires_in_hours) OR payload."predecessorInviteId"<>predecessor."id" OR payload."predecessorTokenVersion"<>predecessor."tokenVersion" OR payload."target"<>predecessor."id") THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  INSERT INTO invitation_protocol."InvitationPreparedPayload"("identityId","householdId","lineageId","normalizedRecipient","offeredRole","expiresAt","predecessorInviteId","predecessorTokenVersion","target") VALUES(identity_row."id",identity_row."householdId",identity_row."lineageId",lower(btrim(predecessor."email")),predecessor."role",identity_row."createdAt"+make_interval(hours=>expires_in_hours),predecessor."id",predecessor."tokenVersion",predecessor."id") ON CONFLICT("identityId") DO NOTHING;
  RETURN jsonb_build_object('operationId',operation_id,'status','prepared');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.submit_manual_invite_replace_v2(operation_id UUID, intent_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; payload invitation_protocol."InvitationPreparedPayload"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; authorization_role public."HouseholdRole"; predecessor public."Invite"%ROWTYPE; raw_token TEXT; invite_id TEXT;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_REPLACE' FOR UPDATE;
  IF NOT FOUND OR octet_length(intent_fingerprint)<>32 OR (request_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_REPLACE',request_attestation);
  SELECT * INTO payload FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id" FOR UPDATE; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  authorization_role:=CASE WHEN identity_row."state"='TERMINAL_FULL' THEN (result_row."safeOutcome"->>'offeredRole')::public."HouseholdRole" ELSE payload."offeredRole" END; PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,authorization_role,false,'manual_invite_replace');
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome")); END IF;
  IF payload."identityId" IS NULL OR identity_row."state"<>'PREPARED' OR payload."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_recipient_v2(payload."householdId",payload."normalizedRecipient"); SELECT * INTO predecessor FROM public."Invite" WHERE "id"=payload."predecessorInviteId" AND "householdId"=payload."householdId" FOR UPDATE;
  IF NOT FOUND OR predecessor."tokenVersion"<>payload."predecessorTokenVersion" OR predecessor."status"<>'pending' OR lower(btrim(predecessor."email"))<>payload."normalizedRecipient" OR predecessor."role"<>payload."offeredRole" THEN RAISE EXCEPTION 'invitation_predecessor_changed'; END IF;
  raw_token:=translate(rtrim(encode(public.gen_random_bytes(32),'base64'),'='),'+/','-_'); invite_id:='inv_'||encode(public.gen_random_bytes(16),'hex');
  UPDATE public."Invite" SET "status"='revoked',"revokedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "id"=predecessor."id" AND "tokenVersion"=payload."predecessorTokenVersion" AND "status"='pending'; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_predecessor_changed'; END IF;
  INSERT INTO public."Invite"("id","householdId","email","role","tokenHash","tokenVersion","status","invitedByUserId","expiresAt","updatedAt") VALUES(invite_id,payload."householdId",payload."normalizedRecipient",payload."offeredRole",encode(public.digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),predecessor."tokenVersion"+1,'pending',(request_attestation).subject_user_id,payload."expiresAt",clock_timestamp());
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'manual_replace'); DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id";
  PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'invite_replaced',jsonb_build_object('expiresAt',payload."expiresAt",'offeredRole',payload."offeredRole")); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.replace',jsonb_build_object('outcome','replaced'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',operation_id,'inviteToken',raw_token,'status','replaced');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.status_manual_invite_replace_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_REPLACE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_unknown'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_REPLACE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,NULL,false,'manual_invite_replace_status');
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'state',identity_row."state",'outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome"));
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.abandon_manual_invite_replace_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MANUAL_INVITE_REPLACE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_unknown'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MANUAL_INVITE_REPLACE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,NULL,false,'manual_invite_replace_abandon');
  IF identity_row."state"='ABANDONED' THEN RETURN jsonb_build_object('operationId',operation_id,'status','abandoned'); END IF; IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.replace',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',operation_id,'status','abandoned');
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.bind_post_signin_invitation_claim_v2(session_id TEXT, claim_identity_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE;
BEGIN
  IF claim_identity_id IS NULL THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),claim_identity_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",identity_row."operationId");
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id" AND "householdId"=identity_row."householdId" AND "lineageId"=identity_row."lineageId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=identity_row."lineageId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=identity_row."householdId" AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=session_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  IF claim_row."identityId" IS NULL OR lineage_row."id" IS NULL OR invite_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR (request_attestation).ordinary_session_id<>session_id OR (request_attestation).subject_user_id<>user_row."id" OR lower(btrim(user_row."email"))<>lower(btrim(invite_row."email")) THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",identity_row."operationId",'PRESENTATION_CLAIM',request_attestation);
  -- An existing account that signs in converges the setup state the credential path creates, anchored to this lineage.
  IF setup_row."userId" IS NULL THEN
    PERFORM 1 FROM public."Account" WHERE "userId"=user_row."id" AND "providerId"='credential' AND "password" IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
    PERFORM 1 FROM public."AccountSecurityState" WHERE "userId"=user_row."id" FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
    INSERT INTO invitation_protocol."InvitationAccountSetup"("userId","originLineageId","originLineageDigest","setupState","accountOrigin") VALUES(user_row."id",lineage_row."id",public.digest(convert_to(lineage_row."id",'UTF8'),'sha256'),'credential_existing','pre_existing') ON CONFLICT ("userId") DO NOTHING;
    SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  END IF;
  IF setup_row."originLineageId" IS DISTINCT FROM lineage_row."id" THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
  IF identity_row."state"='PRESENTATION_SUBJECT_BOUND' AND identity_row."subjectUserId"=user_row."id" AND identity_row."subjectRole"=invite_row."role" AND claim_row."subjectUserId"=user_row."id" THEN RETURN jsonb_build_object('status','review'); END IF;
  IF identity_row."state"<>'PRESENTATION_OPEN' OR identity_row."subjectUserId" IS NOT NULL OR claim_row."subjectUserId" IS NOT NULL THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
  UPDATE invitation_protocol."InvitationPresentationClaim" SET "subjectUserId"=user_row."id" WHERE "identityId"=identity_row."id" AND "subjectUserId" IS NULL;
  UPDATE invitation_protocol."InvitationOperationIdentity" SET "subjectUserId"=user_row."id","subjectRole"=invite_row."role","state"='PRESENTATION_SUBJECT_BOUND' WHERE "id"=identity_row."id" AND "state"='PRESENTATION_OPEN' AND "subjectUserId" IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
  RETURN jsonb_build_object('status','review');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','unavailable');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.recompute_invitation_review_snapshot_v2(claim_identity_id UUID, session_id TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; household_row public."Household"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; inviter_row public."User"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; snapshot JSONB; digest_text TEXT; review_fields TEXT[]:=ARRAY['household_name','offered_role','capabilities','restrictions','inviter_display_name','masked_recipient','server_utc_expiry','localized_relative_expiry','reentry_state','access_restrictions','attribution_audit_privacy','global_security_boundary','other_membership_boundary','recovery_signin_boundary'];
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' AND "state"='PRESENTATION_SUBJECT_BOUND' FOR UPDATE;
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id" AND "subjectUserId"=identity_row."subjectUserId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=identity_row."lineageId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=identity_row."householdId" AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO household_row FROM public."Household" WHERE "id"=identity_row."householdId" AND "deletedAt" IS NULL FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=session_id AND "userId"=identity_row."subjectUserId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE;
  SELECT * INTO inviter_row FROM public."User" WHERE "id"=invite_row."invitedByUserId" FOR UPDATE;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  IF identity_row."id" IS NULL OR claim_row."identityId" IS NULL OR lineage_row."id" IS NULL OR invite_row."id" IS NULL OR household_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR lower(btrim(user_row."email"))<>lower(btrim(invite_row."email")) OR cardinality(review_fields)<>14 THEN RETURN NULL; END IF;
  snapshot:=jsonb_build_object('household_name',household_row."name",'offered_role',invite_row."role"::TEXT,'capabilities',CASE WHEN invite_row."role"='owner' THEN 'full household administration' ELSE 'household access for the offered role' END,'restrictions','household scope only','inviter_display_name',COALESCE(inviter_row."name",'Household member'),'masked_recipient',left(user_row."email",1)||'***@'||split_part(user_row."email",'@',2),'server_utc_expiry',to_char(invite_row."expiresAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localized_relative_expiry','expires from the current server time','reentry_state','sign in again if this session ends','access_restrictions','no membership is created until acceptance','attribution_audit_privacy','household invitation actions are audited','global_security_boundary','account security remains personal','other_membership_boundary','other households are unchanged','recovery_signin_boundary','recovery and sign-in remain separate');
  digest_text:=encode(public.digest(convert_to(jsonb_build_object('reviewVersion',1,'disclosureCopyVersion','invitation-review-copy-v2','snapshot',snapshot)::TEXT,'UTF8'),'sha256'),'hex');
  RETURN snapshot||jsonb_build_object('no_store',true,'reviewVersion',1,'reviewSnapshotDigest',digest_text,'disclosureCopyVersion','invitation-review-copy-v2','lowercase_hex64',digest_text ~ '^[0-9a-f]{64}$','remainingActiveCount',(SELECT count(*) FROM public."RecoveryCode" WHERE "userId"=user_row."id" AND "setVersion"=setup_row."recoverySetVersion" AND "state"='active'));
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.issue_invitation_review_v2(claim_identity_id UUID, session_id TEXT, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; household_row public."Household"%ROWTYPE; inviter_row public."User"%ROWTYPE; snapshot JSONB; digest_text TEXT;
BEGIN
  IF claim_identity_id IS NULL THEN RAISE EXCEPTION 'invitation_review_unavailable'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),claim_identity_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' AND "state"='PRESENTATION_SUBJECT_BOUND' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_review_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",identity_row."operationId");
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id" AND "householdId"=identity_row."householdId" AND "lineageId"=identity_row."lineageId" AND "subjectUserId"=identity_row."subjectUserId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=identity_row."lineageId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=identity_row."householdId" AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO household_row FROM public."Household" WHERE "id"=identity_row."householdId" AND "deletedAt" IS NULL FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=session_id AND "userId"=identity_row."subjectUserId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  SELECT * INTO inviter_row FROM public."User" WHERE "id"=invite_row."invitedByUserId" FOR UPDATE;
  IF claim_row."identityId" IS NULL OR lineage_row."id" IS NULL OR invite_row."id" IS NULL OR household_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR lower(btrim(user_row."email"))<>lower(btrim(invite_row."email")) OR (request_attestation).ordinary_session_id<>session_id OR (request_attestation).subject_user_id<>identity_row."subjectUserId" THEN RAISE EXCEPTION 'invitation_review_unavailable'; END IF;
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",identity_row."operationId",'PRESENTATION_CLAIM',request_attestation);
  snapshot:=invitation_protocol.recompute_invitation_review_snapshot_v2(claim_identity_id,session_id);
  IF snapshot IS NULL THEN RAISE EXCEPTION 'invitation_review_unavailable'; END IF;
  RETURN snapshot;
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','unavailable','no_store',true);
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.revoke_invitation_v2(invite_id TEXT, operation_id UUID, intent_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE invite_row public."Invite"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; claim_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; diagnostic_stage TEXT:='request'; failure_state TEXT; diagnostic_marker TEXT;
BEGIN
  diagnostic_stage:='request';
  IF invite_id IS NULL OR operation_id IS NULL OR octet_length(intent_fingerprint)<>32 OR (request_attestation).target<>invite_id OR (request_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=invite_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_revoke_unavailable'; END IF;
  diagnostic_stage:='authority';
  PERFORM invitation_protocol.lock_invitation_protocol_v2(invite_row."householdId",operation_id);
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,invite_row."householdId",'INVITE_REVOKE','PREPARED',invite_row."id");
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'issuer_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),(request_attestation).opening_fingerprint,(request_attestation).ordinary_session_id,(request_attestation).issuer_membership_episode_id,NULL,invite_id);
  SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" AND "target"=invite_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'INVITE_REVOKE',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,invite_row."role",false,'invite_revoke');
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome")); END IF;
  IF identity_row."state"<>'PREPARED' OR invite_row."status"<>'pending' THEN RAISE EXCEPTION 'invitation_revoke_unavailable'; END IF;
  diagnostic_stage:='invite_transition';
  UPDATE public."Invite" SET "status"='revoked',"revokedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "id"=invite_row."id" AND "status"='pending' AND "tokenVersion"=invite_row."tokenVersion"; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_revoke_unavailable'; END IF;
  diagnostic_stage:='claim_close';
  diagnostic_stage:='claim_lock';
  FOR claim_row IN SELECT i.* FROM invitation_protocol."InvitationOperationIdentity" i JOIN invitation_protocol."InvitationPresentationClaim" c ON c."identityId"=i."id" WHERE i."householdId"=invite_row."householdId" AND i."operationKind"='PRESENTATION_CLAIM' AND i."state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') AND c."tokenHashDigest"=decode(replace(invite_row."tokenHash",'sha256:',''),'hex') FOR UPDATE OF i,c LOOP
    diagnostic_stage:='claim_delete';
    DELETE FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=claim_row."id";
    diagnostic_stage:='claim_tombstone';
    PERFORM invitation_protocol.write_invitation_tombstone_v2(claim_row,'RESERVATION_CLOSE','revoke');
    diagnostic_stage:='claim_lock';
  END LOOP;
  diagnostic_stage:='terminal';
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'invite_revoke'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'invite_revoked',jsonb_build_object('outcome','revoked')); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.revoke',jsonb_build_object('outcome','revoked'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  diagnostic_stage:='deferred_finalization';
  SET CONSTRAINTS invitation_protocol."InvitationOperationIdentity_occupancy_guard", invitation_protocol."InvitationPresentationClaim_occupancy_guard", invitation_protocol."InvitationOperationBinding_occupancy_guard", invitation_protocol."InvitationOperationResult_occupancy_guard", invitation_protocol."InvitationOperationTombstone_occupancy_guard" IMMEDIATE;
  SET CONSTRAINTS invitation_protocol."InvitationOperationIdentity_occupancy_guard", invitation_protocol."InvitationPresentationClaim_occupancy_guard", invitation_protocol."InvitationOperationBinding_occupancy_guard", invitation_protocol."InvitationOperationResult_occupancy_guard", invitation_protocol."InvitationOperationTombstone_occupancy_guard" DEFERRED;
  RETURN jsonb_build_object('operationId',operation_id,'status','revoked');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE;
  diagnostic_marker:=CASE diagnostic_stage WHEN 'request' THEN 'invitation_single_revoke_stage_request_failed' WHEN 'authority' THEN 'invitation_single_revoke_stage_authority_failed' WHEN 'invite_transition' THEN 'invitation_single_revoke_stage_invite_transition_failed' WHEN 'claim_close' THEN 'invitation_single_revoke_stage_claim_close_failed' WHEN 'claim_lock' THEN 'invitation_single_revoke_stage_claim_lock_failed' WHEN 'claim_delete' THEN 'invitation_single_revoke_stage_claim_delete_failed' WHEN 'claim_tombstone' THEN 'invitation_single_revoke_stage_claim_tombstone_failed' WHEN 'terminal' THEN 'invitation_single_revoke_stage_terminal_failed' ELSE 'invitation_single_revoke_stage_deferred_finalization_failed' END;
  RAISE EXCEPTION USING ERRCODE=failure_state,MESSAGE=diagnostic_marker;
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.revoke_all_invitations_v2(household_id TEXT, operation_id UUID, exact_acknowledgement TEXT, intent_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE household_row public."Household"%ROWTYPE; invite_row public."Invite"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; claim_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; revoked_count INTEGER:=0; diagnostic_stage TEXT:='request'; failure_state TEXT; diagnostic_marker TEXT;
BEGIN
  diagnostic_stage:='request';
  IF household_id IS NULL OR operation_id IS NULL OR exact_acknowledgement<>'I_REVOKE_ALL_PENDING_INVITATIONS' THEN RAISE EXCEPTION 'invitation_bulk_acknowledgement_invalid'; END IF;
  IF octet_length(intent_fingerprint)<>32 OR (request_attestation).target<>household_id OR (request_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  SELECT * INTO household_row FROM public."Household" WHERE "id"=household_id AND "deletedAt" IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_revoke_unavailable'; END IF;
  diagnostic_stage:='authority';
  PERFORM invitation_protocol.lock_invitation_protocol_v2(household_id,operation_id);
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,household_id,'INVITE_REVOKE_ALL','PREPARED');
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'issuer_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),(request_attestation).opening_fingerprint,(request_attestation).ordinary_session_id,(request_attestation).issuer_membership_episode_id,NULL,household_id);
  SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" AND "target"=household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'INVITE_REVOKE_ALL',request_attestation); PERFORM invitation_protocol.assert_invitation_issuer_authority_v2(identity_row,request_attestation,NULL,true,'invite_revoke_all');
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode',result_row."outcomeCode",'safeOutcome',result_row."safeOutcome")); END IF;
  IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  diagnostic_stage:='invite_transition';
  FOR invite_row IN SELECT * FROM public."Invite" WHERE "householdId"=household_id AND "status"='pending' ORDER BY "id" FOR UPDATE LOOP
    UPDATE public."Invite" SET "status"='revoked',"revokedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "id"=invite_row."id" AND "status"='pending' AND "tokenVersion"=invite_row."tokenVersion"; IF FOUND THEN revoked_count:=revoked_count+1; END IF;
    diagnostic_stage:='claim_close';
    diagnostic_stage:='claim_lock';
    FOR claim_row IN SELECT i.* FROM invitation_protocol."InvitationOperationIdentity" i JOIN invitation_protocol."InvitationPresentationClaim" c ON c."identityId"=i."id" WHERE i."householdId"=household_id AND i."operationKind"='PRESENTATION_CLAIM' AND i."state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') AND c."tokenHashDigest"=decode(replace(invite_row."tokenHash",'sha256:',''),'hex') FOR UPDATE OF i,c LOOP
      diagnostic_stage:='claim_delete';
      DELETE FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=claim_row."id";
      diagnostic_stage:='claim_tombstone';
      PERFORM invitation_protocol.write_invitation_tombstone_v2(claim_row,'RESERVATION_CLOSE','revoke');
      diagnostic_stage:='claim_lock';
    END LOOP;
    diagnostic_stage:='invite_transition';
  END LOOP;
  diagnostic_stage:='terminal';
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'invite_revoke_all'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'invites_revoked',jsonb_build_object('revokedCount',revoked_count)); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invite.revoke_all',jsonb_build_object('outcome','revoked_all'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  diagnostic_stage:='deferred_finalization';
  SET CONSTRAINTS invitation_protocol."InvitationOperationIdentity_occupancy_guard", invitation_protocol."InvitationPresentationClaim_occupancy_guard", invitation_protocol."InvitationOperationBinding_occupancy_guard", invitation_protocol."InvitationOperationResult_occupancy_guard", invitation_protocol."InvitationOperationTombstone_occupancy_guard" IMMEDIATE;
  SET CONSTRAINTS invitation_protocol."InvitationOperationIdentity_occupancy_guard", invitation_protocol."InvitationPresentationClaim_occupancy_guard", invitation_protocol."InvitationOperationBinding_occupancy_guard", invitation_protocol."InvitationOperationResult_occupancy_guard", invitation_protocol."InvitationOperationTombstone_occupancy_guard" DEFERRED;
  RETURN jsonb_build_object('operationId',operation_id,'status','revoked','revokedCount',revoked_count);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE;
  diagnostic_marker:=CASE diagnostic_stage WHEN 'request' THEN 'invitation_bulk_revoke_stage_request_failed' WHEN 'authority' THEN 'invitation_bulk_revoke_stage_authority_failed' WHEN 'invite_transition' THEN 'invitation_bulk_revoke_stage_invite_transition_failed' WHEN 'claim_close' THEN 'invitation_bulk_revoke_stage_claim_close_failed' WHEN 'claim_lock' THEN 'invitation_bulk_revoke_stage_claim_lock_failed' WHEN 'claim_delete' THEN 'invitation_bulk_revoke_stage_claim_delete_failed' WHEN 'claim_tombstone' THEN 'invitation_bulk_revoke_stage_claim_tombstone_failed' WHEN 'terminal' THEN 'invitation_bulk_revoke_stage_terminal_failed' ELSE 'invitation_bulk_revoke_stage_deferred_finalization_failed' END;
  RAISE EXCEPTION USING ERRCODE=failure_state,MESSAGE=diagnostic_marker;
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.expire_invitation_v2(invite_id TEXT, database_clock_guard TIMESTAMPTZ, worker_attestation invitation_protocol.invitation_expiry_worker_carrier) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE invite_row public."Invite"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  IF session_user<>'cubby_invitation_expiry_worker' OR (worker_attestation).invite_id<>invite_id OR octet_length((worker_attestation).worker_nonce)<>32 OR (worker_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (worker_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' OR database_clock_guard<clock_timestamp()-INTERVAL '30 seconds' OR database_clock_guard>clock_timestamp()+INTERVAL '30 seconds' THEN RAISE EXCEPTION 'invitation_expiry_denied'; END IF;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=invite_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(invite_row."householdId",gen_random_uuid());
  PERFORM 1 FROM invitation_protocol."InvitationLineage" WHERE "householdId"=invite_row."householdId" AND "sourceInviteId"=invite_row."id" FOR UPDATE;
  IF invite_row."status"='expired' THEN RETURN; END IF;
  IF invite_row."status"<>'pending' OR invite_row."expiresAt">clock_timestamp() THEN RETURN; END IF;
  UPDATE public."Invite" SET "status"='expired',"updatedAt"=clock_timestamp() WHERE "id"=invite_row."id" AND "status"='pending' AND "tokenVersion"=invite_row."tokenVersion";
  IF NOT FOUND THEN RETURN; END IF;
  FOR identity_row IN SELECT i.* FROM invitation_protocol."InvitationOperationIdentity" i JOIN invitation_protocol."InvitationPresentationClaim" c ON c."identityId"=i."id" WHERE i."householdId"=invite_row."householdId" AND i."operationKind"='PRESENTATION_CLAIM' AND i."state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') AND c."tokenHashDigest"=decode(invite_row."tokenHash",'hex') FOR UPDATE OF i,c LOOP
    DELETE FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id";
    PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','expiry');
  END LOOP;
  PERFORM invitation_protocol.write_invitation_audit_v2(invite_row."householdId",NULL,'invite.expire',jsonb_build_object('outcome','expired'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='invitation_expiry_denied' THEN RAISE; END IF;
  RAISE EXCEPTION 'invitation_expiry_denied';
END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.verify_invitation_preaccount_credential_attestation_v1(scope_identity_id UUID, scope_operation_id UUID, scope_opening BYTEA, scope_intent BYTEA, scope_password_hash_digest BYTEA, scope_attestation invitation_protocol.invitation_preaccount_credential_attestation)
RETURNS invitation_protocol."InvitationPresentationClaim" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; key_row public."FreshAuthAttestationKey"%ROWTYPE; previous invitation_protocol."InvitationRequestAttestation"%ROWTYPE; payload BYTEA:=convert_to('cubby.invitation.preaccount-credential-attestation.v1','UTF8');
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=scope_identity_id AND "operationId"=scope_operation_id AND "operationKind"='CREDENTIAL_SETUP' FOR UPDATE;
  IF NOT FOUND OR octet_length(scope_opening)<>32 OR (scope_intent IS NOT NULL AND octet_length(scope_intent)<>32) OR (scope_password_hash_digest IS NOT NULL AND octet_length(scope_password_hash_digest)<>32) THEN RAISE EXCEPTION 'invitation_credential_attestation_invalid'; END IF;
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=(scope_attestation).claim_identity_id AND "householdId"=identity_row."householdId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=claim_row."lineageId" AND "householdId"=identity_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=identity_row."householdId" AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=(scope_attestation).key_version AND ("active" OR "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes') FOR SHARE;
  IF claim_row."identityId" IS NULL OR lineage_row."id" IS NULL OR invite_row."id" IS NULL OR key_row."keyVersion" IS NULL OR (scope_attestation).operation_kind<>'CREDENTIAL_SETUP' OR (scope_attestation).operation_id<>scope_operation_id OR (scope_attestation).opening_fingerprint<>scope_opening OR (scope_attestation).intent_fingerprint IS DISTINCT FROM scope_intent OR (scope_attestation).password_hash_digest IS DISTINCT FROM scope_password_hash_digest OR (scope_attestation).browser_partition_digest<>claim_row."browserPartitionDigest" OR (scope_attestation).recipient_email_digest<>public.digest(convert_to(lower(btrim(invite_row."email")),'UTF8'),'sha256') OR octet_length((scope_attestation).nonce)<>32 OR octet_length((scope_attestation).mac)<>32 OR (scope_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (scope_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' THEN RAISE EXCEPTION 'invitation_credential_attestation_invalid'; END IF;
  payload:=payload||uuid_send((scope_attestation).claim_identity_id)||(scope_attestation).browser_partition_digest||(scope_attestation).recipient_email_digest||convert_to('CREDENTIAL_SETUP','UTF8')||uuid_send(scope_operation_id)||scope_opening||COALESCE(scope_intent,''::BYTEA)||COALESCE(scope_password_hash_digest,''::BYTEA)||(scope_attestation).nonce||int4send((scope_attestation).key_version);
  IF public.hmac(payload,key_row."verificationKey",'sha256')<>(scope_attestation).mac THEN RAISE EXCEPTION 'invitation_credential_attestation_invalid'; END IF;
  SELECT * INTO previous FROM invitation_protocol."InvitationRequestAttestation" WHERE "nonce"=(scope_attestation).nonce FOR UPDATE;
  IF FOUND AND (previous."identityId"<>scope_identity_id OR previous."macDigest"<>public.digest((scope_attestation).mac,'sha256')) THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  IF NOT FOUND THEN INSERT INTO invitation_protocol."InvitationRequestAttestation"("id","identityId","keyVersion","nonce","issuedAt","macDigest","target","openingFingerprint","intentFingerprint","purpose") VALUES(gen_random_uuid(),scope_identity_id,(scope_attestation).key_version,(scope_attestation).nonce,(scope_attestation).issued_at,public.digest((scope_attestation).mac,'sha256'),(scope_attestation).claim_identity_id::TEXT,scope_opening,scope_intent,'credential_preaccount'); END IF;
  RETURN claim_row;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.verify_invitation_credential_status_attestation_v1(scope_identity_id UUID, scope_operation_id UUID, scope_attestation invitation_protocol.invitation_credential_status_attestation)
RETURNS invitation_protocol."InvitationOperationIdentity" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; key_row public."FreshAuthAttestationKey"%ROWTYPE; payload BYTEA:=convert_to('cubby.invitation.credential-status-attestation.v1','UTF8');
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=scope_identity_id AND "operationId"=scope_operation_id AND "operationKind"='CREDENTIAL_SETUP' FOR UPDATE;
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=(scope_attestation).claim_identity_id AND "householdId"=identity_row."householdId" AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=claim_row."lineageId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "status"='pending' FOR UPDATE;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=(scope_attestation).key_version AND ("active" OR "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes') FOR SHARE;
  IF identity_row."id" IS NULL OR claim_row."identityId" IS NULL OR invite_row."id" IS NULL OR key_row."keyVersion" IS NULL OR (scope_attestation).operation_kind<>'CREDENTIAL_SETUP' OR (scope_attestation).operation_id<>scope_operation_id OR (scope_attestation).browser_partition_digest<>claim_row."browserPartitionDigest" OR (scope_attestation).recipient_email_digest<>public.digest(convert_to(lower(btrim(invite_row."email")),'UTF8'),'sha256') OR octet_length((scope_attestation).nonce)<>32 OR octet_length((scope_attestation).mac)<>32 OR (scope_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' THEN RAISE EXCEPTION 'invitation_credential_status_unavailable'; END IF;
  payload:=payload||uuid_send((scope_attestation).claim_identity_id)||(scope_attestation).browser_partition_digest||(scope_attestation).recipient_email_digest||convert_to('CREDENTIAL_SETUP','UTF8')||uuid_send(scope_operation_id)||(scope_attestation).nonce||int4send((scope_attestation).key_version);
  IF public.hmac(payload,key_row."verificationKey",'sha256')<>(scope_attestation).mac THEN RAISE EXCEPTION 'invitation_credential_status_unavailable'; END IF;
  RETURN identity_row;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.assert_invitation_recovery_subject_v2(scope_identity invitation_protocol."InvitationOperationIdentity", scope_attestation invitation_protocol.invitation_request_attestation, scope_purpose TEXT)
RETURNS public."AccountSecurityState" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; session_row public."Session"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE;
BEGIN
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(scope_attestation).subject_user_id AND "originLineageId"=scope_identity."lineageId" FOR UPDATE;
  SELECT * INTO session_row FROM public."Session" WHERE "id"=(scope_attestation).ordinary_session_id AND "userId"=(scope_attestation).subject_user_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=(scope_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=scope_identity."id" FOR UPDATE;
  IF setup_row."userId" IS NULL OR session_row."id" IS NULL OR state_row."userId" IS NULL OR binding_row."identityId" IS NULL OR binding_row."ordinarySessionId" IS DISTINCT FROM (scope_attestation).ordinary_session_id OR binding_row."target"<>(scope_attestation).subject_user_id OR binding_row."openingFingerprint" IS DISTINCT FROM (scope_attestation).opening_fingerprint OR binding_row."expiresAt"<=clock_timestamp() OR (scope_attestation).purpose<>scope_purpose THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=scope_identity."id";
  RETURN state_row;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.verify_invitation_recovery_verifier_batch_v1(scope_batch invitation_protocol.recovery_verifier_batch, scope_digest BYTEA)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE verifier invitation_protocol.recovery_verifier_record; calculated BYTEA:=convert_to('cubby.invitation.recovery-verifier-batch.v1','UTF8'); total INTEGER; unique_ids INTEGER; unique_ordinals INTEGER;
BEGIN
  IF scope_batch IS NULL OR octet_length(scope_digest) IS DISTINCT FROM 32 OR (scope_batch).batch_digest IS DISTINCT FROM scope_digest OR cardinality((scope_batch).records) IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'invitation_recovery_verifier_batch_invalid'; END IF;
  SELECT count(*),count(DISTINCT (record).code_id),count(DISTINCT (record).ordinal) INTO total,unique_ids,unique_ordinals FROM unnest((scope_batch).records) AS record;
  IF total<>10 OR unique_ids<>10 OR unique_ordinals<>10 THEN RAISE EXCEPTION 'invitation_recovery_verifier_batch_invalid'; END IF;
  FOR verifier IN SELECT (record).* FROM unnest((scope_batch).records) AS record ORDER BY (record).ordinal LOOP
    IF verifier.ordinal IS NULL OR verifier.ordinal NOT BETWEEN 1 AND 10 OR verifier.code_id IS NULL OR octet_length(verifier.salt) IS DISTINCT FROM 16 OR octet_length(verifier.derived_key) IS DISTINCT FROM 32 OR verifier.kdf_version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'invitation_recovery_verifier_batch_invalid'; END IF;
    calculated:=calculated||int4send(verifier.ordinal)||int4send(octet_length(convert_to(verifier.code_id,'UTF8')))||convert_to(verifier.code_id,'UTF8')||verifier.salt||verifier.derived_key||int4send(verifier.kdf_version);
  END LOOP;
  IF public.digest(calculated,'sha256') IS DISTINCT FROM scope_digest THEN RAISE EXCEPTION 'invitation_recovery_verifier_batch_invalid'; END IF;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_credential_setup_v2(operation_id UUID, claim_identity_id UUID, opening_fingerprint BYTEA, claim_attestation invitation_protocol.invitation_preaccount_credential_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; parent_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO parent_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' AND "state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') FOR UPDATE;
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=claim_identity_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=parent_row."lineageId" AND "householdId"=parent_row."householdId" FOR UPDATE;
  IF operation_id IS NULL OR claim_row."identityId" IS NULL OR octet_length(opening_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_reservation_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(parent_row."householdId",operation_id);
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,parent_row."householdId",'CREDENTIAL_SETUP','PREPARED',lineage_row."sourceInviteId");
  IF identity_row."state"<>'PREPARED' OR EXISTS (SELECT 1 FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" AND ("carrierDigest"<>claim_row."browserPartitionDigest" OR "openingFingerprint"<>opening_fingerprint OR "target"<>claim_identity_id::TEXT)) THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'claim_partition',claim_row."browserPartitionDigest",opening_fingerprint,NULL,NULL,NULL,claim_identity_id::TEXT);
  PERFORM invitation_protocol.verify_invitation_preaccount_credential_attestation_v1(identity_row."id",operation_id,opening_fingerprint,NULL,NULL,claim_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'prepared');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.submit_invitation_credential_setup_v2(operation_id UUID, intent_fingerprint BYTEA, display_name TEXT, password_hash TEXT, password_hash_digest BYTEA, credential_attestation invitation_protocol.invitation_preaccount_credential_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; existing_user public."User"%ROWTYPE; existing_account public."Account"%ROWTYPE; existing_state public."AccountSecurityState"%ROWTYPE; created_user_id TEXT; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='CREDENTIAL_SETUP' FOR UPDATE;
  IF identity_row."id" IS NULL OR octet_length(intent_fingerprint)<>32 OR octet_length(password_hash_digest)<>32 OR password_hash IS NULL OR password_hash_digest<>public.digest(convert_to(password_hash,'UTF8'),'sha256') OR nullif(btrim(display_name),'') IS NULL THEN RAISE EXCEPTION 'invitation_credential_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id);
  claim_row:=invitation_protocol.verify_invitation_preaccount_credential_attestation_v1(identity_row."id",operation_id,(credential_attestation).opening_fingerprint,intent_fingerprint,password_hash_digest,credential_attestation);
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=claim_row."lineageId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "status"='pending' FOR UPDATE;
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN invitation_protocol.invitation_safe_receipt(operation_id,'continue_with_sign_in',result_row."outcomeCode"); END IF;
  SELECT * INTO existing_user FROM public."User" WHERE lower("email")=lower(btrim(invite_row."email")) FOR UPDATE;
  IF existing_user."id" IS NULL THEN
    created_user_id:='usr_'||encode(public.gen_random_bytes(16),'hex');
    INSERT INTO public."User"("id","name","email","emailVerified","createdAt","updatedAt") VALUES(created_user_id,left(btrim(display_name),120),lower(btrim(invite_row."email")),false,clock_timestamp(),clock_timestamp());
    INSERT INTO public."Account"("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES('acc_'||encode(public.gen_random_bytes(16),'hex'),created_user_id,'credential',created_user_id,password_hash,clock_timestamp(),clock_timestamp());
    INSERT INTO public."AccountSecurityState"("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES(created_user_id,1,1,clock_timestamp());
    INSERT INTO invitation_protocol."InvitationAccountSetup"("userId","originLineageId","originLineageDigest","setupState","accountOrigin") VALUES(created_user_id,lineage_row."id",public.digest(convert_to(lineage_row."id",'UTF8'),'sha256'),'credential_created','invitation_created');
  ELSE
    SELECT * INTO existing_account FROM public."Account" WHERE "userId"=existing_user."id" AND "providerId"='credential' AND "password" IS NOT NULL FOR UPDATE;
    SELECT * INTO existing_state FROM public."AccountSecurityState" WHERE "userId"=existing_user."id" FOR UPDATE;
    IF existing_account."id" IS NULL OR existing_state."userId" IS NULL THEN RAISE EXCEPTION 'invitation_credential_unavailable'; END IF;
  END IF;
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'credential_setup');
  PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'continue_with_sign_in',jsonb_build_object('status','continue_with_sign_in'));
  PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'credential.setup',jsonb_build_object('outcome','continue_with_sign_in'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'continue_with_sign_in','continue_with_sign_in');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.status_invitation_credential_setup_v2(operation_id UUID, status_attestation invitation_protocol.invitation_credential_status_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='CREDENTIAL_SETUP' FOR UPDATE;
  IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.verify_invitation_credential_status_attestation_v1(identity_row."id",operation_id,status_attestation);
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,CASE WHEN identity_row."state"='TERMINAL_FULL' THEN 'continue_with_sign_in' ELSE 'prepared' END,result_row."outcomeCode");
EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.abandon_invitation_credential_setup_v2(operation_id UUID, status_attestation invitation_protocol.invitation_credential_status_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='CREDENTIAL_SETUP' FOR UPDATE;
  IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.verify_invitation_credential_status_attestation_v1(identity_row."id",operation_id,status_attestation);
  IF identity_row."state"='ABANDONED' THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned'); END IF;
  IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'credential.setup',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_recovery_rehearsal_v2(operation_id UUID, selected_recovery_code_id TEXT, exact_save_acknowledgement TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; set_row public."RecoveryCodeSet"%ROWTYPE; code_row public."RecoveryCode"%ROWTYPE; challenge_row invitation_protocol."InvitationRecoveryRehearsalChallenge"%ROWTYPE;
BEGIN
  IF operation_id IS NULL THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),operation_id);
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=setup_row."originLineageId" FOR UPDATE;
  IF operation_id IS NULL OR lineage_row."id" IS NULL OR exact_save_acknowledgement<>'I SAVED MY RECOVERY CODES' OR octet_length(opening_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(lineage_row."householdId",operation_id); identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,lineage_row."householdId",'RECOVERY_REHEARSAL','PREPARED',lineage_row."sourceInviteId");
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'subject_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),opening_fingerprint,(request_attestation).ordinary_session_id,NULL,(request_attestation).subject_membership_episode_id,(request_attestation).subject_user_id);
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_REHEARSAL',request_attestation); state_row:=invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_rehearsal_reserve'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT * INTO set_row FROM public."RecoveryCodeSet" WHERE "userId"=(request_attestation).subject_user_id AND "setVersion"=setup_row."recoverySetVersion" FOR UPDATE; SELECT * INTO code_row FROM public."RecoveryCode" WHERE "id"=selected_recovery_code_id AND "userId"=(request_attestation).subject_user_id AND "setVersion"=set_row."setVersion" AND "state"='active' FOR UPDATE;
  IF set_row."userId" IS NULL OR code_row."id" IS NULL OR set_row."state" NOT IN ('generated','save_acknowledged','rehearsal_required') THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  SELECT * INTO challenge_row FROM invitation_protocol."InvitationRecoveryRehearsalChallenge" WHERE "operationIdentityId"=identity_row."id" FOR UPDATE;
  IF challenge_row."operationIdentityId" IS NOT NULL THEN IF challenge_row."selectedRecoveryCodeId"<>selected_recovery_code_id OR challenge_row."saveAcknowledgementVersion"<>exact_save_acknowledgement OR challenge_row."openingFingerprint"<>opening_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_build_object('operationId',operation_id,'status','prepared','nonce',encode(challenge_row."nonce",'hex'),'expiresAt',challenge_row."expiresAt",'operationIdentityId',challenge_row."operationIdentityId",'credentialVersion',challenge_row."credentialVersion",'sessionSecurityVersion',challenge_row."sessionSecurityVersion",'recoverySetVersion',challenge_row."recoverySetVersion",'salt',encode(code_row."salt",'hex'),'derivedKey',encode(code_row."derivedKey",'hex'),'kdfVersion',code_row."kdfVersion"); END IF;
  UPDATE public."RecoveryCodeSet" SET "state"='save_acknowledged',"saveAcknowledgedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "userId"=set_row."userId" AND "setVersion"=set_row."setVersion" AND "state"='generated'; UPDATE public."RecoveryCodeSet" SET "state"='rehearsal_required',"updatedAt"=clock_timestamp() WHERE "userId"=set_row."userId" AND "setVersion"=set_row."setVersion" AND "state"='save_acknowledged';
  INSERT INTO invitation_protocol."InvitationRecoveryRehearsalChallenge"("operationIdentityId","householdId","lineageId","subjectUserId","ordinarySessionId","credentialVersion","sessionSecurityVersion","recoverySetVersion","selectedRecoveryCodeId","operationId","saveAcknowledgementVersion","openingFingerprint","nonce","expiresAt") VALUES(identity_row."id",identity_row."householdId",identity_row."lineageId",(request_attestation).subject_user_id,(request_attestation).ordinary_session_id,state_row."credentialVersion",state_row."sessionSecurityVersion",set_row."setVersion",selected_recovery_code_id,operation_id,exact_save_acknowledgement,opening_fingerprint,public.gen_random_bytes(32),clock_timestamp()+INTERVAL '10 minutes') RETURNING * INTO challenge_row;
  RETURN jsonb_build_object('operationId',operation_id,'status','prepared','nonce',encode(challenge_row."nonce",'hex'),'expiresAt',challenge_row."expiresAt",'operationIdentityId',challenge_row."operationIdentityId",'credentialVersion',challenge_row."credentialVersion",'sessionSecurityVersion',challenge_row."sessionSecurityVersion",'recoverySetVersion',challenge_row."recoverySetVersion",'salt',encode(code_row."salt",'hex'),'derivedKey',encode(code_row."derivedKey",'hex'),'kdfVersion',code_row."kdfVersion");
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.submit_invitation_recovery_rehearsal_v2(operation_id UUID, intent_fingerprint BYTEA, selected_recovery_code_id TEXT, nonce BYTEA, attestation_key_version INTEGER, attestation_mac BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; challenge_row invitation_protocol."InvitationRecoveryRehearsalChallenge"%ROWTYPE; set_row public."RecoveryCodeSet"%ROWTYPE; code_row public."RecoveryCode"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; global_operation public."GlobalSecurityOperation"%ROWTYPE; global_binding public."GlobalSecurityOperationBinding"%ROWTYPE; remainingActiveCount INTEGER;
BEGIN
  IF operation_id IS NULL THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_REHEARSAL' FOR UPDATE; IF identity_row."id" IS NULL OR octet_length(intent_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_REHEARSAL',request_attestation); state_row:=invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_rehearsal_submit'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT * INTO challenge_row FROM invitation_protocol."InvitationRecoveryRehearsalChallenge" WHERE "operationIdentityId"=identity_row."id" FOR UPDATE; SELECT * INTO set_row FROM public."RecoveryCodeSet" WHERE "userId"=challenge_row."subjectUserId" AND "setVersion"=challenge_row."recoverySetVersion" FOR UPDATE; SELECT * INTO code_row FROM public."RecoveryCode" WHERE "id"=selected_recovery_code_id AND "userId"=challenge_row."subjectUserId" AND "setVersion"=challenge_row."recoverySetVersion" FOR UPDATE; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint OR challenge_row."selectedRecoveryCodeId"<>selected_recovery_code_id OR challenge_row."nonce"<>nonce OR challenge_row."attestationKeyVersion" IS DISTINCT FROM attestation_key_version OR challenge_row."attestationMacDigest" IS DISTINCT FROM public.digest(attestation_mac,'sha256') THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode',result_row."outcomeCode",'recoverySetVersion',challenge_row."recoverySetVersion",'remainingActiveCount',9,'terminalAt',result_row."terminalAt"); END IF;
  PERFORM 1 FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=attestation_key_version AND ("active" OR "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes') FOR SHARE;
  SELECT * INTO global_operation FROM public."GlobalSecurityOperation" WHERE "userId"=challenge_row."subjectUserId" AND "operationId"=set_row."issuanceOperationId" AND "operationKey"='recovery_enrollment'::public."GlobalSecurityOperationKey" AND "status"='pending'::public."GlobalSecurityOperationStatus" FOR UPDATE;
  SELECT * INTO global_binding FROM public."GlobalSecurityOperationBinding" WHERE "id"=global_operation."bindingId" AND "userId"=challenge_row."subjectUserId" AND "operationId"=set_row."issuanceOperationId" AND "state"='submitted' FOR UPDATE;
  IF identity_row."state"<>'PREPARED' OR challenge_row."state"<>'issued' OR challenge_row."expiresAt"<=clock_timestamp() OR challenge_row."selectedRecoveryCodeId"<>selected_recovery_code_id OR challenge_row."nonce"<>nonce OR code_row."id" IS NULL OR code_row."state"<>'active' OR set_row."state"<>'rehearsal_required' OR global_operation."bindingId" IS NULL OR global_binding."id" IS NULL OR global_binding."expiresAt"<=clock_timestamp() OR challenge_row."credentialVersion"<>state_row."credentialVersion" OR challenge_row."sessionSecurityVersion"<>state_row."sessionSecurityVersion" OR NOT invitation_protocol.verify_invitation_recovery_rehearsal_attestation_v1(challenge_row."subjectUserId",challenge_row."ordinarySessionId",challenge_row."operationIdentityId",operation_id,state_row."credentialVersion",state_row."sessionSecurityVersion",challenge_row."recoverySetVersion",selected_recovery_code_id,nonce,attestation_key_version,challenge_row."openingFingerprint",intent_fingerprint,attestation_mac) THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM 1 FROM public."RecoveryCode" WHERE "userId"=challenge_row."subjectUserId" AND "setVersion"=challenge_row."recoverySetVersion" AND "state"='active' FOR UPDATE;
  SELECT count(*) INTO remainingActiveCount FROM public."RecoveryCode" WHERE "userId"=challenge_row."subjectUserId" AND "setVersion"=challenge_row."recoverySetVersion" AND "state"='active'; IF remainingActiveCount<>10 THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  UPDATE public."RecoveryCode" SET "state"='consumed',"consumedPurpose"='enrollment_rehearsal',"consumedOperationId"=set_row."issuanceOperationId","consumedAt"=clock_timestamp() WHERE "id"=code_row."id" AND "state"='active'; UPDATE public."RecoveryCodeSet" SET "state"='rehearsed',"rehearsedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "userId"=set_row."userId" AND "setVersion"=set_row."setVersion" AND "state"='rehearsal_required'; UPDATE invitation_protocol."InvitationAccountSetup" SET "setupState"='rehearsed' WHERE "userId"=challenge_row."subjectUserId" AND "recoverySetVersion"=challenge_row."recoverySetVersion" AND "setupState"='recovery_generated'; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  SELECT count(*) INTO remainingActiveCount FROM public."RecoveryCode" WHERE "userId"=challenge_row."subjectUserId" AND "setVersion"=challenge_row."recoverySetVersion" AND "state"='active'; IF remainingActiveCount<>9 THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  UPDATE invitation_protocol."InvitationRecoveryRehearsalChallenge" SET "state"='consumed',"consumedAt"=clock_timestamp(),"attestationKeyVersion"=attestation_key_version,"attestationMacDigest"=public.digest(attestation_mac,'sha256'),"intentFingerprint"=intent_fingerprint WHERE "operationIdentityId"=challenge_row."operationIdentityId" AND "state"='issued';
  UPDATE public."GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='rehearsal_completed',"outcomeSnapshot"=jsonb_build_object('setVersion',challenge_row."recoverySetVersion",'remainingCodes',remainingActiveCount),"terminalAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "userId"=challenge_row."subjectUserId" AND "operationId"=set_row."issuanceOperationId" AND "status"='pending';
  UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=clock_timestamp() WHERE "id"=global_binding."id" AND "state"='submitted';
  PERFORM public.write_global_security_event(challenge_row."subjectUserId",'recovery','rehearsed',set_row."issuanceOperationId");
  PERFORM public.write_global_security_event(challenge_row."subjectUserId",'operation_outcome','completed',set_row."issuanceOperationId");
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'recovery_rehearsal'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'rehearsal_completed',jsonb_build_object('recoverySetVersion',challenge_row."recoverySetVersion",'remainingActiveCount',remainingActiveCount)); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'recovery.rehearse',jsonb_build_object('outcome','completed'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN jsonb_build_object('operationId',operation_id,'status','completed','outcomeCode','rehearsal_completed','recoverySetVersion',challenge_row."recoverySetVersion",'remainingActiveCount',remainingActiveCount,'terminalAt',clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.status_invitation_recovery_rehearsal_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; challenge_row invitation_protocol."InvitationRecoveryRehearsalChallenge"%ROWTYPE; remainingActiveCount INTEGER:=0; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE;
BEGIN
  IF operation_id IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_REHEARSAL' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_REHEARSAL',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_rehearsal_status'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT * INTO challenge_row FROM invitation_protocol."InvitationRecoveryRehearsalChallenge" WHERE "operationIdentityId"=identity_row."id"; SELECT count(*) INTO remainingActiveCount FROM public."RecoveryCode" WHERE "userId"=(request_attestation).subject_user_id AND "setVersion"=challenge_row."recoverySetVersion" AND "state"='active'; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id";
  RETURN jsonb_build_object('operationId',operation_id,'status',CASE WHEN identity_row."state"='TERMINAL_FULL' THEN 'completed' ELSE 'prepared' END,'outcomeCode',result_row."outcomeCode",'recoverySetVersion',challenge_row."recoverySetVersion",'remainingActiveCount',remainingActiveCount);
EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.abandon_invitation_recovery_rehearsal_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  IF operation_id IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_REHEARSAL' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_REHEARSAL',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_rehearsal_abandon'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  IF identity_row."state"='ABANDONED' THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned'); END IF; IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; DELETE FROM invitation_protocol."InvitationRecoveryRehearsalChallenge" WHERE "operationIdentityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'recovery.rehearse',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation); RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.write_invitation_audit_v2(scope_household_id TEXT, scope_nullable_identity_id UUID, scope_action invitation_protocol.invitation_audit_action, scope_safe_projection JSONB, scope_helper_attestation invitation_protocol.invitation_owner_private_call_attestation) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE audit_id TEXT;
BEGIN
  IF (scope_helper_attestation).marker<>'owner' OR jsonb_typeof(scope_safe_projection)<>'object' OR octet_length(convert_to(scope_safe_projection::TEXT,'UTF8'))>2048 THEN RAISE EXCEPTION 'invitation_audit_projection_invalid'; END IF;
  audit_id:='iae_'||encode(public.gen_random_bytes(16),'hex'); INSERT INTO public."AuditEvent"("id","householdId","action","entityType","entityId","chainOrder","after","createdAt") VALUES(audit_id,scope_household_id,scope_action::TEXT,'invitation',COALESCE(scope_nullable_identity_id::TEXT,scope_household_id),COALESCE((SELECT max("chainOrder")+1 FROM public."AuditEvent" WHERE "householdId"=scope_household_id),1),scope_safe_projection,clock_timestamp()); RETURN audit_id;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_recovery_enrollment_v2(operation_id UUID, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; bridge_row invitation_protocol."InvitationRecoveryEnrollmentBridge"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(request_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=setup_row."originLineageId" FOR UPDATE;
  IF operation_id IS NULL OR lineage_row."id" IS NULL OR octet_length(opening_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(lineage_row."householdId",operation_id);
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,lineage_row."householdId",'RECOVERY_ENROLLMENT','PREPARED',lineage_row."sourceInviteId");
  PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'subject_session',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),opening_fingerprint,(request_attestation).ordinary_session_id,NULL,(request_attestation).subject_membership_episode_id,(request_attestation).subject_user_id);
  identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_enrollment_reserve');
  PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT * INTO bridge_row FROM invitation_protocol."InvitationRecoveryEnrollmentBridge" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF bridge_row."identityId" IS NULL THEN
    INSERT INTO invitation_protocol."InvitationRecoveryEnrollmentBridge"("identityId","householdId","lineageId","subjectUserId","ordinarySessionId","globalSecurityOperationId") VALUES(identity_row."id",identity_row."householdId",identity_row."lineageId",(request_attestation).subject_user_id,(request_attestation).ordinary_session_id,'gso_'||substring(encode(public.gen_random_bytes(16),'hex') FROM 1 FOR 26)) RETURNING * INTO bridge_row;
  ELSIF bridge_row."householdId"<>identity_row."householdId" OR bridge_row."lineageId"<>identity_row."lineageId" OR bridge_row."subjectUserId"<>(request_attestation).subject_user_id OR bridge_row."ordinarySessionId"<>(request_attestation).ordinary_session_id THEN
    RAISE EXCEPTION 'invitation_operation_conflict';
  END IF;
  RETURN jsonb_build_object('operationId',operation_id,'status','prepared','globalSecurityOperationId',bridge_row."globalSecurityOperationId");
END $$;

-- The bridge mapping is the only authority for the canonical operation identity. It is resolved and
-- fully authorized here so a browser-supplied identity can never precede canonical grant creation.
CREATE OR REPLACE FUNCTION invitation_protocol.authorize_invitation_recovery_enrollment_fresh_auth_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; bridge_row invitation_protocol."InvitationRecoveryEnrollmentBridge"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_ENROLLMENT' FOR UPDATE;
  IF identity_row."id" IS NULL THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_enrollment_authorize');
  SELECT * INTO bridge_row FROM invitation_protocol."InvitationRecoveryEnrollmentBridge" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF bridge_row."identityId" IS NULL OR identity_row."state"<>'PREPARED' OR bridge_row."globalSecurityOperationId" IS NULL OR bridge_row."householdId"<>identity_row."householdId" OR bridge_row."lineageId"<>identity_row."lineageId" OR bridge_row."subjectUserId"<>(request_attestation).subject_user_id OR bridge_row."ordinarySessionId"<>(request_attestation).ordinary_session_id THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  IF bridge_row."freshAuthBoundAt" IS NOT NULL AND bridge_row."intentFingerprint" IS DISTINCT FROM (request_attestation).intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  RETURN jsonb_build_object('operationId',operation_id,'status','authorized','globalSecurityOperationId',bridge_row."globalSecurityOperationId");
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.bind_invitation_recovery_enrollment_fresh_auth_v2(operation_id UUID, intent_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; bridge_row invitation_protocol."InvitationRecoveryEnrollmentBridge"%ROWTYPE; global_binding public."GlobalSecurityOperationBinding"%ROWTYPE; global_operation public."GlobalSecurityOperation"%ROWTYPE; grant_row public."FreshAuthGrant"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_ENROLLMENT' FOR UPDATE;
  IF identity_row."id" IS NULL OR octet_length(intent_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_enrollment_fresh_auth');
  SELECT * INTO bridge_row FROM invitation_protocol."InvitationRecoveryEnrollmentBridge" WHERE "identityId"=identity_row."id" FOR UPDATE;
  SELECT * INTO global_binding FROM public."GlobalSecurityOperationBinding" WHERE "userId"=(request_attestation).subject_user_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "operationKey"='recovery_enrollment'::public."GlobalSecurityOperationKey" AND "state"='submitted' FOR UPDATE;
  SELECT * INTO global_operation FROM public."GlobalSecurityOperation" WHERE "userId"=(request_attestation).subject_user_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "bindingId"=global_binding."id" AND "operationKey"='recovery_enrollment'::public."GlobalSecurityOperationKey" AND "status"='pending'::public."GlobalSecurityOperationStatus" FOR UPDATE;
  SELECT * INTO grant_row FROM public."FreshAuthGrant" WHERE "userId"=(request_attestation).subject_user_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "purpose"='recovery_enrollment' AND "state"='issued'::public."FreshAuthGrantState" AND "expiresAt">clock_timestamp() FOR UPDATE;
  IF bridge_row."identityId" IS NULL OR global_binding."id" IS NULL OR global_operation."bindingId" IS NULL OR grant_row."id" IS NULL OR global_binding."sessionId"<>(request_attestation).ordinary_session_id OR global_binding."openingFingerprint"<>encode((request_attestation).opening_fingerprint,'hex') THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  IF bridge_row."freshAuthBoundAt" IS NOT NULL THEN IF bridge_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN jsonb_build_object('operationId',operation_id,'status','fresh_auth_bound'); END IF;
  UPDATE invitation_protocol."InvitationRecoveryEnrollmentBridge" SET "intentFingerprint"=intent_fingerprint,"freshAuthBoundAt"=clock_timestamp() WHERE "identityId"=identity_row."id" AND "freshAuthBoundAt" IS NULL;
  RETURN jsonb_build_object('operationId',operation_id,'status','fresh_auth_bound');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.submit_invitation_recovery_enrollment_v2(operation_id UUID, intent_fingerprint BYTEA, verifier_batch invitation_protocol.recovery_verifier_batch, verifier_batch_digest BYTEA, issuance_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; bridge_row invitation_protocol."InvitationRecoveryEnrollmentBridge"%ROWTYPE; global_binding public."GlobalSecurityOperationBinding"%ROWTYPE; global_operation public."GlobalSecurityOperation"%ROWTYPE; grant_row public."FreshAuthGrant"%ROWTYPE; set_version INTEGER; verifier invitation_protocol.recovery_verifier_record; restricted RECORD;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_ENROLLMENT' FOR UPDATE;
  IF identity_row."id" IS NULL OR octet_length(intent_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',issuance_attestation); state_row:=invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,issuance_attestation,'recovery_enrollment_submit');
  PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE;
  PERFORM invitation_protocol.verify_invitation_recovery_verifier_batch_v1(verifier_batch,verifier_batch_digest);
  SELECT * INTO bridge_row FROM invitation_protocol."InvitationRecoveryEnrollmentBridge" WHERE "identityId"=identity_row."id" FOR UPDATE;
  IF (issuance_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint OR split_part((issuance_attestation).target,':',2)::INTEGER IS DISTINCT FROM state_row."credentialVersion" OR split_part((issuance_attestation).target,':',3)::INTEGER IS DISTINCT FROM state_row."sessionSecurityVersion" OR decode(split_part((issuance_attestation).target,':',5),'hex') IS DISTINCT FROM verifier_batch_digest THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  IF identity_row."state"='TERMINAL_FULL' THEN
    IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint OR bridge_row."verifierBatchDigest" IS DISTINCT FROM verifier_batch_digest OR split_part((issuance_attestation).target,':',4)::INTEGER IS DISTINCT FROM (result_row."safeOutcome"->>'recoverySetVersion')::INTEGER THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
    RETURN invitation_protocol.invitation_safe_receipt(operation_id,'generated',result_row."outcomeCode");
  END IF;
  IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(issuance_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO bridge_row FROM invitation_protocol."InvitationRecoveryEnrollmentBridge" WHERE "identityId"=identity_row."id" FOR UPDATE;
  SELECT * INTO global_binding FROM public."GlobalSecurityOperationBinding" WHERE "userId"=(issuance_attestation).subject_user_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "operationKey"='recovery_enrollment'::public."GlobalSecurityOperationKey" AND "state"='submitted' FOR UPDATE;
  SELECT * INTO global_operation FROM public."GlobalSecurityOperation" WHERE "userId"=(issuance_attestation).subject_user_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "bindingId"=global_binding."id" AND "operationKey"='recovery_enrollment'::public."GlobalSecurityOperationKey" AND "status"='pending'::public."GlobalSecurityOperationStatus" FOR UPDATE;
  SELECT * INTO grant_row FROM public."FreshAuthGrant" WHERE "userId"=(issuance_attestation).subject_user_id AND "sessionId"=(issuance_attestation).ordinary_session_id AND "operationId"=bridge_row."globalSecurityOperationId" AND "purpose"='recovery_enrollment' AND "credentialVersion"=state_row."credentialVersion" AND "state"='issued'::public."FreshAuthGrantState" AND "expiresAt">clock_timestamp() FOR UPDATE;
  IF setup_row."userId" IS NULL OR bridge_row."identityId" IS NULL OR bridge_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint OR bridge_row."freshAuthBoundAt" IS NULL OR global_binding."id" IS NULL OR global_operation."bindingId" IS NULL OR grant_row."id" IS NULL OR global_binding."sessionId"<>(issuance_attestation).ordinary_session_id OR global_binding."openingFingerprint"<>encode((issuance_attestation).opening_fingerprint,'hex') THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM 1 FROM public."RecoveryCodeSet" WHERE "userId"=(issuance_attestation).subject_user_id ORDER BY "setVersion" FOR UPDATE;
  -- Canonical issuance closes every restricted reset carrier that a superseded set still authorizes.
  FOR restricted IN SELECT session_row."id",session_row."operationId" FROM public."RecoverySession" session_row JOIN public."RecoveryCode" code_row ON code_row."id"=session_row."recoveryCodeId" AND code_row."userId"=session_row."userId" JOIN public."RecoveryCodeSet" set_row ON set_row."userId"=code_row."userId" AND set_row."setVersion"=code_row."setVersion" WHERE session_row."userId"=(issuance_attestation).subject_user_id AND session_row."state"='restricted' AND code_row."state"='consumed' AND code_row."consumedPurpose"='recovery_reset' AND set_row."state"<>'invalidated' ORDER BY session_row."id" FOR UPDATE OF session_row,code_row,set_row LOOP
    UPDATE public."GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='recovery_set_regenerated',"outcomeSnapshot"='{}',"terminalAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "userId"=(issuance_attestation).subject_user_id AND "operationId"=restricted."operationId" AND "status" IN ('pending'::public."GlobalSecurityOperationStatus",'unknown'::public."GlobalSecurityOperationStatus");
    UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=clock_timestamp() WHERE "userId"=(issuance_attestation).subject_user_id AND "operationId"=restricted."operationId" AND "state"='submitted';
    UPDATE public."RecoverySession" SET "state"='closed',"closedAt"=clock_timestamp() WHERE "id"=restricted."id" AND "userId"=(issuance_attestation).subject_user_id AND "state"='restricted';
    PERFORM public.write_global_security_event((issuance_attestation).subject_user_id,'operation_outcome','rejected',restricted."operationId");
  END LOOP;
  UPDATE public."RecoveryCode" SET "state"='invalidated',"invalidatedAt"=clock_timestamp() WHERE "userId"=(issuance_attestation).subject_user_id AND "state"='active';
  UPDATE public."RecoveryCodeSet" SET "state"='invalidated',"updatedAt"=clock_timestamp() WHERE "userId"=(issuance_attestation).subject_user_id AND "state"<>'invalidated';
  set_version:=COALESCE((SELECT max("setVersion")+1 FROM public."RecoveryCodeSet" WHERE "userId"=(issuance_attestation).subject_user_id),1);
  IF set_version IS DISTINCT FROM split_part((issuance_attestation).target,':',4)::INTEGER THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  UPDATE invitation_protocol."InvitationRecoveryEnrollmentBridge" SET "verifierBatchDigest"=verifier_batch_digest WHERE "identityId"=identity_row."id" AND "verifierBatchDigest" IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  INSERT INTO public."RecoveryCodeSet"("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","expectedCodeCount","state","createdAt","updatedAt") VALUES((issuance_attestation).subject_user_id,set_version,bridge_row."globalSecurityOperationId",grant_row."id",state_row."credentialVersion",state_row."sessionSecurityVersion",10,'generated',clock_timestamp(),clock_timestamp());
  FOR verifier IN SELECT (record).* FROM unnest((verifier_batch).records) AS record ORDER BY (record).ordinal LOOP
    INSERT INTO public."RecoveryCode"("id","userId","setVersion","ordinal","salt","derivedKey","kdfVersion","state","createdAt") VALUES(verifier.code_id,(issuance_attestation).subject_user_id,set_version,verifier.ordinal,verifier.salt,verifier.derived_key,verifier.kdf_version,'active',clock_timestamp());
  END LOOP;
  -- The canonical sequence consumes the proof only once the complete set exists, then records the
  -- private issuance event exactly once.
  UPDATE public."FreshAuthGrant" SET "state"='consumed',"consumedAt"=clock_timestamp() WHERE "id"=grant_row."id" AND "state"='issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM public.write_global_security_event((issuance_attestation).subject_user_id,'recovery','code_set_generated',bridge_row."globalSecurityOperationId");
  UPDATE invitation_protocol."InvitationAccountSetup" SET "recoverySetVersion"=set_version,"setupState"='recovery_generated' WHERE "userId"=(issuance_attestation).subject_user_id;
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'recovery_enrollment'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'recovery_codes_generated',jsonb_build_object('recoverySetVersion',set_version)); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'recovery.enroll',jsonb_build_object('outcome','generated'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'generated','recovery_codes_generated')||jsonb_build_object('displayOnce',true);
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.status_invitation_recovery_enrollment_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; remainingActiveCount INTEGER:=0; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; set_version INTEGER;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_ENROLLMENT' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_enrollment_status'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  SELECT count(*) INTO remainingActiveCount FROM public."RecoveryCode" WHERE "userId"=(request_attestation).subject_user_id AND "state"='active'; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id";
  SELECT * INTO state_row FROM public."AccountSecurityState" WHERE "userId"=(request_attestation).subject_user_id FOR UPDATE;
  set_version:=CASE WHEN identity_row."state"='TERMINAL_FULL' THEN (result_row."safeOutcome"->>'recoverySetVersion')::INTEGER ELSE COALESCE((SELECT max("setVersion")+1 FROM public."RecoveryCodeSet" WHERE "userId"=(request_attestation).subject_user_id),1) END;
  RETURN jsonb_build_object('operationId',operation_id,'status',CASE WHEN identity_row."state"='TERMINAL_FULL' THEN 'generated' ELSE 'prepared' END,'outcomeCode',result_row."outcomeCode",'remainingActiveCount',remainingActiveCount,'credentialVersion',state_row."credentialVersion",'sessionSecurityVersion',state_row."sessionSecurityVersion",'recoverySetVersion',set_version);
EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.abandon_invitation_recovery_enrollment_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='RECOVERY_ENROLLMENT' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'RECOVERY_ENROLLMENT',request_attestation); PERFORM invitation_protocol.assert_invitation_recovery_subject_v2(identity_row,request_attestation,'recovery_enrollment_abandon'); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id";
  IF identity_row."state"='ABANDONED' THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned'); END IF; IF identity_row."state"<>'PREPARED' THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF;
  DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'recovery.enroll',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_acceptance_v2(operation_id UUID, claim_identity_id UUID, review_version INTEGER, review_snapshot_digest TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; claim_identity invitation_protocol."InvitationOperationIdentity"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; review JSONB; review_fields TEXT[]:=ARRAY['household_name','offered_role','capabilities','restrictions','inviter_display_name','masked_recipient','server_utc_expiry','localized_relative_expiry','reentry_state','access_restrictions','attribution_audit_privacy','global_security_boundary','other_membership_boundary','recovery_signin_boundary'];
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  SELECT * INTO claim_identity FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_identity_id AND "operationKind"='PRESENTATION_CLAIM' AND "state"='PRESENTATION_SUBJECT_BOUND' FOR UPDATE; IF claim_identity."id" IS NULL OR operation_id IS NULL OR octet_length(opening_fingerprint)<>32 OR review_version<=0 OR review_snapshot_digest !~ '^[0-9a-f]{64}$' OR (request_attestation).operation_id<>operation_id OR (request_attestation).operation_kind<>'MEMBERSHIP_ACCEPTANCE' THEN RAISE EXCEPTION 'invitation_reservation_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(claim_identity."householdId",operation_id); SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=claim_identity."id" AND "subjectUserId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO invite_row FROM public."Invite" i JOIN invitation_protocol."InvitationLineage" l ON l."sourceInviteId"=i."id" WHERE l."id"=claim_identity."lineageId" AND i."status"='pending' AND i."expiresAt">clock_timestamp() FOR UPDATE OF i; SELECT * INTO session_row FROM public."Session" WHERE "id"=(request_attestation).ordinary_session_id AND "userId"=(request_attestation).subject_user_id AND "expiresAt">clock_timestamp() FOR UPDATE; SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE;
  review:=invitation_protocol.recompute_invitation_review_snapshot_v2(claim_identity."id",(request_attestation).ordinary_session_id);
  IF claim_row."identityId" IS NULL OR invite_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR review IS NULL OR (review->>'reviewVersion')::INTEGER<>review_version OR review->>'reviewSnapshotDigest'<>review_snapshot_digest OR review->>'lowercase_hex64'<>'true' THEN RAISE EXCEPTION 'stale_review'; END IF;
  identity_row:=invitation_protocol.create_invitation_identity_v2(operation_id,claim_identity."householdId",'MEMBERSHIP_ACCEPTANCE','PREPARED',claim_identity."lineageId"); PERFORM invitation_protocol.write_invitation_binding_v2(identity_row,'subject_session_claim',public.digest(convert_to((request_attestation).ordinary_session_id,'UTF8'),'sha256'),opening_fingerprint,(request_attestation).ordinary_session_id,NULL,(request_attestation).subject_membership_episode_id,claim_identity_id::TEXT); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MEMBERSHIP_ACCEPTANCE',request_attestation); PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id" FOR UPDATE; RETURN invitation_protocol.invitation_safe_receipt(operation_id,'prepared');
EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.submit_invitation_acceptance_v2(operation_id UUID, review_version INTEGER, review_snapshot_digest TEXT, intent_fingerprint BYTEA, typed_household_name TEXT, nullable_admin_acknowledgement TEXT, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; invite_row public."Invite"%ROWTYPE; household_row public."Household"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; set_row public."RecoveryCodeSet"%ROWTYPE; inviter_member public."HouseholdMember"%ROWTYPE; member_row public."HouseholdMember"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; review JSONB; remainingActiveCount INTEGER; outcome TEXT; membership_id TEXT; review_fields TEXT[]:=ARRAY['household_name','offered_role','capabilities','restrictions','inviter_display_name','masked_recipient','server_utc_expiry','localized_relative_expiry','reentry_state','access_restrictions','attribution_audit_privacy','global_security_boundary','other_membership_boundary','recovery_signin_boundary'];
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MEMBERSHIP_ACCEPTANCE' FOR UPDATE; IF identity_row."id" IS NULL OR octet_length(intent_fingerprint)<>32 OR review_version<=0 OR review_snapshot_digest !~ '^[0-9a-f]{64}$' OR (request_attestation).intent_fingerprint IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_submit_invalid'; END IF;
  PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MEMBERSHIP_ACCEPTANCE',request_attestation); SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" FOR UPDATE; SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=binding_row."target"::UUID AND "subjectUserId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO invite_row FROM public."Invite" i JOIN invitation_protocol."InvitationLineage" l ON l."sourceInviteId"=i."id" WHERE l."id"=claim_row."lineageId" AND i."status"='pending' AND i."expiresAt">clock_timestamp() FOR UPDATE OF i; SELECT * INTO household_row FROM public."Household" WHERE "id"=identity_row."householdId" AND "deletedAt" IS NULL FOR UPDATE; SELECT * INTO session_row FROM public."Session" WHERE "id"=(request_attestation).ordinary_session_id AND "expiresAt">clock_timestamp() FOR UPDATE; SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE; PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id" FOR UPDATE;
  SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE; IF identity_row."state"='TERMINAL_FULL' THEN IF result_row."intentFingerprint" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; RETURN invitation_protocol.invitation_safe_receipt(operation_id,'completed',result_row."outcomeCode"); END IF;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE; SELECT * INTO set_row FROM public."RecoveryCodeSet" WHERE "userId"=user_row."id" AND "setVersion"=setup_row."recoverySetVersion" AND "state"='rehearsed' FOR UPDATE; review:=invitation_protocol.recompute_invitation_review_snapshot_v2(binding_row."target"::UUID,(request_attestation).ordinary_session_id);
  IF claim_row."identityId" IS NULL OR invite_row."id" IS NULL OR household_row."id" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR setup_row."userId" IS NULL OR setup_row."setupState"<>'rehearsed' OR set_row."userId" IS NULL OR binding_row."openingFingerprint" IS DISTINCT FROM (request_attestation).opening_fingerprint OR identity_row."state"<>'PREPARED' OR review IS NULL OR (review->>'reviewVersion')::INTEGER<>review_version OR review->>'reviewSnapshotDigest'<>review_snapshot_digest OR review->>'lowercase_hex64'<>'true' THEN RAISE EXCEPTION 'stale_review'; END IF;
  IF lower(btrim(normalize(typed_household_name,NFKC)))<>lower(btrim(normalize(household_row."name",NFKC))) OR (invite_row."role"='admin' AND nullable_admin_acknowledgement<>'I UNDERSTAND ADMIN ACCESS') OR (invite_row."role"<>'admin' AND nullable_admin_acknowledgement IS NOT NULL) THEN RAISE EXCEPTION 'stale_review'; END IF;
  PERFORM 1 FROM public."RecoveryCodeSet" WHERE "userId"=user_row."id" AND "state"='rehearsed' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'stale_review'; END IF; SELECT count(*) INTO remainingActiveCount FROM public."RecoveryCode" WHERE "userId"=user_row."id" AND "state"='active'; IF remainingActiveCount<>9 THEN RAISE EXCEPTION 'stale_review'; END IF;
  SELECT * INTO inviter_member FROM public."HouseholdMember" WHERE "householdId"=identity_row."householdId" AND "userId"=invite_row."invitedByUserId" AND "disabledAt" IS NULL AND "deletedAt" IS NULL ORDER BY "createdAt" DESC FOR UPDATE; IF inviter_member."id" IS NULL OR (invite_row."role"='admin' AND inviter_member."role"<>'owner') OR (invite_row."role" IN ('parent','caretaker','read_only') AND inviter_member."role" NOT IN ('owner','admin')) THEN RAISE EXCEPTION 'inviter_authority_lost'; END IF;
  SELECT * INTO member_row FROM public."HouseholdMember" WHERE "householdId"=identity_row."householdId" AND "userId"=user_row."id" ORDER BY "createdAt" DESC FOR UPDATE; IF member_row."id" IS NULL OR member_row."deletedAt" IS NOT NULL THEN membership_id:='hm_'||encode(public.gen_random_bytes(16),'hex'); INSERT INTO public."HouseholdMember"("id","householdId","userId","role","joinedAt","createdAt","updatedAt") VALUES(membership_id,identity_row."householdId",user_row."id",invite_row."role",clock_timestamp(),clock_timestamp(),clock_timestamp()); outcome:=CASE WHEN member_row."id" IS NULL THEN 'created' ELSE 'reentered' END; ELSIF member_row."disabledAt" IS NOT NULL THEN RAISE EXCEPTION 'suspended'; ELSIF member_row."role"<>invite_row."role" THEN RAISE EXCEPTION 'active_different_role'; ELSE membership_id:=member_row."id"; outcome:='already_member_same_role'; END IF;
  UPDATE public."Invite" SET "status"='accepted',"acceptedByUserId"=user_row."id","acceptedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE "id"=invite_row."id" AND "status"='pending'; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_operation_conflict'; END IF; UPDATE invitation_protocol."InvitationAccountSetup" SET "setupState"='accepted' WHERE "userId"=user_row."id" AND "setupState"='rehearsed'; IF NOT FOUND THEN RAISE EXCEPTION 'stale_review'; END IF; PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'membership_acceptance'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'membership_accepted',jsonb_build_object('outcome',outcome)); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'membership.accept',jsonb_build_object('outcome',outcome),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation); RETURN invitation_protocol.invitation_safe_receipt(operation_id,'completed','membership_accepted');
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.status_invitation_acceptance_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; result_row invitation_protocol."InvitationOperationResult"%ROWTYPE; BEGIN PERFORM invitation_protocol.lock_global_security_transition_v1(); SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MEMBERSHIP_ACCEPTANCE' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MEMBERSHIP_ACCEPTANCE',request_attestation); SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" FOR UPDATE; SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=binding_row."target"::UUID AND "subjectUserId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO invite_row FROM public."Invite" WHERE "householdId"=identity_row."householdId" FOR UPDATE; SELECT * INTO session_row FROM public."Session" WHERE "id"=(request_attestation).ordinary_session_id AND "expiresAt">clock_timestamp() FOR UPDATE; SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE; PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id" FOR UPDATE; IF binding_row."identityId" IS NULL OR claim_row."identityId" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; SELECT * INTO result_row FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" FOR UPDATE; RETURN jsonb_strip_nulls(jsonb_build_object('operationId',operation_id,'status',CASE WHEN identity_row."state"='TERMINAL_FULL' THEN 'completed' ELSE 'prepared' END,'outcomeCode',result_row."outcomeCode")); EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END $$;
CREATE OR REPLACE FUNCTION invitation_protocol.abandon_invitation_acceptance_v2(operation_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; binding_row invitation_protocol."InvitationOperationBinding"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; BEGIN PERFORM invitation_protocol.lock_global_security_transition_v1(); SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "operationId"=operation_id AND "operationKind"='MEMBERSHIP_ACCEPTANCE' FOR UPDATE; IF identity_row."id" IS NULL THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",operation_id); identity_row:=invitation_protocol.reauthorize_invitation_carrier_v2(identity_row."id",operation_id,'MEMBERSHIP_ACCEPTANCE',request_attestation); SELECT * INTO binding_row FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id" FOR UPDATE; SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=binding_row."target"::UUID AND "subjectUserId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO invite_row FROM public."Invite" WHERE "householdId"=identity_row."householdId" FOR UPDATE; SELECT * INTO session_row FROM public."Session" WHERE "id"=(request_attestation).ordinary_session_id AND "expiresAt">clock_timestamp() FOR UPDATE; SELECT * INTO user_row FROM public."User" WHERE "id"=session_row."userId" FOR UPDATE; PERFORM 1 FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id" FOR UPDATE; IF binding_row."identityId" IS NULL OR claim_row."identityId" IS NULL OR session_row."id" IS NULL OR user_row."id" IS NULL OR identity_row."state"<>'PREPARED' THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END IF; DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'RESERVATION_CLOSE','abandoned'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'membership.accept',jsonb_build_object('outcome','abandoned'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation); RETURN invitation_protocol.invitation_safe_receipt(operation_id,'abandoned'); EXCEPTION WHEN OTHERS THEN RETURN invitation_protocol.invitation_safe_receipt(operation_id,'unavailable'); END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.compact_invitation_operation_v2(identity_id UUID, worker_attestation invitation_protocol.invitation_maintenance_worker_carrier) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE;
BEGIN
  IF session_user<>'cubby_invitation_maintenance_worker' OR identity_id IS NULL OR (worker_attestation).identity_id<>identity_id OR octet_length((worker_attestation).worker_nonce)<>32 OR (worker_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (worker_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' THEN RAISE EXCEPTION 'invitation_maintenance_denied'; END IF;
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=identity_id FOR UPDATE; IF identity_row."id" IS NULL OR identity_row."state"='COMPACTED' THEN RETURN; END IF; PERFORM invitation_protocol.lock_invitation_protocol_v2(identity_row."householdId",identity_row."operationId");
  IF identity_row."state"<>'TERMINAL_FULL' OR identity_row."terminalAt" IS NULL OR identity_row."terminalAt">clock_timestamp()-INTERVAL '30 days' THEN RAISE EXCEPTION 'invitation_compaction_unavailable'; END IF;
  DELETE FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; DELETE FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id"; PERFORM invitation_protocol.write_invitation_tombstone_v2(identity_row,'FULL_COMPACTION','compacted'); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'invitation.operation.compact',jsonb_build_object('operationKind',identity_row."operationKind"::TEXT,'compactedCount',1),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.write_invitation_audit_v2(scope_household_id TEXT, scope_nullable_identity_id UUID, scope_action invitation_protocol.invitation_audit_action, scope_safe_projection JSONB, scope_helper_attestation invitation_protocol.invitation_owner_private_call_attestation) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE audit_id TEXT; allowed_keys TEXT[]; actual_keys TEXT[];
BEGIN
  IF (scope_helper_attestation).marker<>'owner' OR scope_household_id IS NULL OR jsonb_typeof(scope_safe_projection)<>'object' OR octet_length(convert_to(scope_safe_projection::TEXT,'UTF8'))>2048 OR scope_safe_projection::TEXT ~* '(rawToken|password|recovery|email)' THEN RAISE EXCEPTION 'invitation_audit_projection_invalid'; END IF;
  SELECT "allowedKeys" INTO allowed_keys FROM invitation_protocol."InvitationAuditProjectionAllowlist" WHERE "action"=scope_action; IF allowed_keys IS NULL THEN RAISE EXCEPTION 'invitation_audit_unknown_action'; END IF; SELECT coalesce(array_agg(key ORDER BY key),ARRAY[]::TEXT[]) INTO actual_keys FROM jsonb_object_keys(scope_safe_projection) key; IF actual_keys IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM unnest(allowed_keys) key) THEN RAISE EXCEPTION 'invitation_audit_unknown_field'; END IF;
  audit_id:='iae_'||encode(public.gen_random_bytes(16),'hex'); INSERT INTO public."AuditEvent"("id","householdId","action","entityType","entityId","chainOrder","after","createdAt") VALUES(audit_id,scope_household_id,scope_action::TEXT,'invitation',COALESCE(scope_nullable_identity_id::TEXT,scope_household_id),COALESCE((SELECT max("chainOrder")+1 FROM public."AuditEvent" WHERE "householdId"=scope_household_id),1),scope_safe_projection,clock_timestamp()); RETURN audit_id;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationOperationIdentity_occupancy_guard"() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_count INTEGER; binding_count INTEGER; payload_count INTEGER; result_count INTEGER; tombstone_count INTEGER; attestation_count INTEGER; terminal_result BOOLEAN;
BEGIN
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=COALESCE((to_jsonb(NEW)->>'id')::UUID,(to_jsonb(OLD)->>'id')::UUID,(to_jsonb(NEW)->>'identityId')::UUID,(to_jsonb(OLD)->>'identityId')::UUID); IF identity_row."id" IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO claim_count FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id"; SELECT count(*) INTO binding_count FROM invitation_protocol."InvitationOperationBinding" WHERE "identityId"=identity_row."id"; SELECT count(*) INTO payload_count FROM invitation_protocol."InvitationPreparedPayload" WHERE "identityId"=identity_row."id"; SELECT count(*) INTO result_count FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id"; SELECT count(*) INTO tombstone_count FROM invitation_protocol."InvitationOperationTombstone" WHERE "identityId"=identity_row."id"; SELECT count(*) INTO attestation_count FROM invitation_protocol."InvitationRequestAttestation" WHERE "identityId"=identity_row."id"; SELECT EXISTS (SELECT 1 FROM invitation_protocol."InvitationOperationResult" WHERE "identityId"=identity_row."id" AND ("terminalAt" IS NOT NULL OR "status" IN ('completed','rejected','stale'))) INTO terminal_result;
  IF claim_count>1 OR binding_count>1 OR payload_count>1 OR result_count>1 OR tombstone_count>1 OR (tombstone_count=1 AND (claim_count<>0 OR binding_count<>0 OR payload_count<>0 OR result_count<>0)) OR (result_count=1 AND binding_count<>1) THEN RAISE EXCEPTION 'invitation_operation_peer_occupancy_invalid'; END IF;
  IF identity_row."operationKind"='PRESENTATION_CLAIM' AND NOT ((identity_row."state" IN ('PRESENTATION_OPEN','PRESENTATION_SUBJECT_BOUND') AND claim_count=1 AND binding_count=0 AND payload_count=0 AND result_count=0 AND tombstone_count=0) OR (identity_row."state"='PRESENTATION_CLOSED' AND claim_count=0 AND binding_count=0 AND payload_count=0 AND result_count=0 AND tombstone_count=1)) THEN RAISE EXCEPTION 'invitation_presentation_occupancy_invalid'; END IF;
  IF identity_row."operationKind" IN ('MANUAL_INVITE_CREATE','MANUAL_INVITE_REPLACE') AND identity_row."state"='PREPARED' AND (payload_count<>1 OR attestation_count<1) THEN RAISE EXCEPTION 'invitation_operation_occupancy_invalid'; END IF;
  IF identity_row."operationKind"<>'PRESENTATION_CLAIM' AND NOT ((identity_row."state"='PREPARED' AND binding_count=1 AND result_count=0 AND tombstone_count=0) OR (identity_row."state"='SUBMITTED' AND binding_count=1 AND result_count=1 AND NOT terminal_result AND tombstone_count=0) OR (identity_row."state"='TERMINAL_FULL' AND binding_count=1 AND result_count=1 AND terminal_result AND tombstone_count=0) OR (identity_row."state"='COMPACTED' AND binding_count=0 AND payload_count=0 AND result_count=0 AND tombstone_count=1) OR (identity_row."state"='ABANDONED' AND binding_count=0 AND payload_count=0 AND result_count=0 AND tombstone_count=1)) THEN RAISE EXCEPTION 'invitation_operation_occupancy_invalid'; END IF; RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.classify_invitation_setup_corridor_v2(session_id TEXT, setup_attestation invitation_protocol.invitation_setup_corridor_attestation) RETURNS invitation_protocol.setup_corridor_result LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; account_row public."Account"%ROWTYPE; key_row public."FreshAuthAttestationKey"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; payload BYTEA;
BEGIN
  IF session_user<>'cubby_invitation_runtime' OR session_id IS NULL OR (setup_attestation).ordinary_session_id IS NULL OR (setup_attestation).subject_user_id IS NULL OR (setup_attestation).purpose IS NULL OR length((setup_attestation).purpose) NOT BETWEEN 1 AND 191 OR (setup_attestation).ordinary_session_id<>session_id OR octet_length((setup_attestation).nonce)<>32 OR octet_length((setup_attestation).mac)<>32 OR (setup_attestation).issued_at<clock_timestamp()-INTERVAL '10 minutes' OR (setup_attestation).issued_at>clock_timestamp()+INTERVAL '30 seconds' THEN RETURN 'neutral'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2((setup_attestation).subject_user_id,'00000000-0000-4000-8000-000000000000'::UUID);
  SELECT * INTO session_row FROM public."Session" WHERE "id"=session_id AND "userId"=(setup_attestation).subject_user_id AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO user_row FROM public."User" WHERE "id"=(setup_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=(setup_attestation).key_version AND ("active" OR (NOT "active" AND "rotatedAt">=clock_timestamp()-INTERVAL '10 minutes')) FOR SHARE;
  payload:=convert_to('cubby.invitation.setup-corridor-attestation.v1','UTF8')||int4send(octet_length(convert_to((setup_attestation).ordinary_session_id,'UTF8')))||convert_to((setup_attestation).ordinary_session_id,'UTF8')||int4send(octet_length(convert_to((setup_attestation).subject_user_id,'UTF8')))||convert_to((setup_attestation).subject_user_id,'UTF8')||int4send(octet_length(convert_to((setup_attestation).purpose,'UTF8')))||convert_to((setup_attestation).purpose,'UTF8')||(setup_attestation).nonce||timestamptz_send((setup_attestation).issued_at)||int4send((setup_attestation).key_version);
  IF session_row."id" IS NULL OR user_row."id" IS NULL OR key_row."keyVersion" IS NULL OR public.hmac(payload,key_row."verificationKey",'sha256')<>(setup_attestation).mac THEN RETURN 'neutral'; END IF;
  INSERT INTO invitation_protocol."InvitationSetupCorridorAttestationReceipt"("nonce","ordinarySessionId","subjectUserId","purpose","keyVersion","issuedAt","macDigest") VALUES((setup_attestation).nonce,session_id,(setup_attestation).subject_user_id,(setup_attestation).purpose,(setup_attestation).key_version,(setup_attestation).issued_at,public.digest((setup_attestation).mac,'sha256')) ON CONFLICT ("nonce") DO NOTHING;
  IF NOT FOUND THEN RETURN 'neutral'; END IF;
  SELECT * INTO account_row FROM public."Account" WHERE "userId"=user_row."id" AND "providerId"='credential' AND "password" IS NOT NULL FOR UPDATE;
  IF account_row."id" IS NULL THEN RETURN 'neutral'; END IF;
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  SELECT claim.* INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" claim JOIN invitation_protocol."InvitationOperationIdentity" identity_candidate ON identity_candidate."id"=claim."identityId" JOIN invitation_protocol."InvitationLineage" lineage_candidate ON lineage_candidate."id"=claim."lineageId" AND lineage_candidate."householdId"=claim."householdId" JOIN public."Invite" invite_candidate ON invite_candidate."id"=lineage_candidate."sourceInviteId" AND invite_candidate."householdId"=claim."householdId" WHERE claim."expiresAt">clock_timestamp() AND invite_candidate."status"='pending' AND invite_candidate."expiresAt">clock_timestamp() AND ((claim."subjectUserId"=user_row."id" AND identity_candidate."state"='PRESENTATION_SUBJECT_BOUND' AND identity_candidate."subjectUserId"=user_row."id") OR (claim."subjectUserId" IS NULL AND identity_candidate."state"='PRESENTATION_OPEN' AND lower(btrim(invite_candidate."email"))=lower(btrim(user_row."email")))) ORDER BY (claim."subjectUserId" IS NOT NULL) DESC,claim."expiresAt" DESC,claim."identityId" FOR UPDATE OF claim,identity_candidate,lineage_candidate,invite_candidate LIMIT 1;
  IF claim_row."identityId" IS NULL OR claim_row."subjectUserId" IS NULL THEN
    IF setup_row."userId" IS NULL OR setup_row."setupState"='accepted' OR setup_row."accountOrigin"='pre_existing' THEN RETURN 'ordinary'; END IF;
    RETURN 'neutral';
  END IF;
  IF setup_row."accountOrigin"='pre_existing' THEN RETURN 'ordinary'; END IF;
  SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=claim_row."identityId" AND "state"='PRESENTATION_SUBJECT_BOUND' AND "subjectUserId"=user_row."id" FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=claim_row."lineageId" AND "householdId"=claim_row."householdId" FOR UPDATE;
  SELECT * INTO invite_row FROM public."Invite" WHERE "id"=lineage_row."sourceInviteId" AND "householdId"=claim_row."householdId" AND "status"='pending' AND "expiresAt">clock_timestamp() FOR UPDATE;
  SELECT * INTO claim_row FROM invitation_protocol."InvitationPresentationClaim" WHERE "identityId"=identity_row."id" AND "householdId"=identity_row."householdId" AND "lineageId"=identity_row."lineageId" AND "subjectUserId"=user_row."id" AND "expiresAt">clock_timestamp() FOR UPDATE;
  IF identity_row."id" IS NULL OR lineage_row."id" IS NULL OR invite_row."id" IS NULL OR claim_row."identityId" IS NULL THEN RETURN 'neutral'; END IF;
  RETURN 'setup_required';
END $$;

ALTER SCHEMA invitation_protocol OWNER TO invitation_protocol_owner_NOLOGIN;
DO $$
DECLARE object_row RECORD;
BEGIN
  FOR object_row IN SELECT c.oid::regclass AS object_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='invitation_protocol' AND c.relkind IN ('r','S') LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO invitation_protocol_owner_NOLOGIN',object_row.object_name);
  END LOOP;
  FOR object_row IN SELECT p.oid::regprocedure AS object_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO invitation_protocol_owner_NOLOGIN',object_row.object_name);
  END LOOP;
  FOR object_row IN SELECT t.oid::regtype AS object_name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='invitation_protocol' AND t.typtype IN ('d','e') LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO invitation_protocol_owner_NOLOGIN',object_row.object_name);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."Invite",public."HouseholdMember",public."User",public."Account",public."AccountSecurityState",public."RecoveryCodeSet",public."RecoveryCode",public."AuditEvent" TO invitation_protocol_owner_NOLOGIN;
GRANT SELECT,UPDATE ON public."FreshAuthAttestationKey" TO invitation_protocol_owner_NOLOGIN;
GRANT SELECT,UPDATE ON public."Household",public."Session" TO invitation_protocol_owner_NOLOGIN;
GRANT INSERT ON public."FreshAuthGrant",public."GlobalSecurityOperation",public."GlobalSecurityOperationBinding" TO invitation_protocol_owner_NOLOGIN;
GRANT SELECT,UPDATE ON public."FreshAuthGrant",public."GlobalSecurityOperation",public."GlobalSecurityOperationBinding",public."GlobalSecurityEvent" TO invitation_protocol_owner_NOLOGIN;
GRANT SELECT,UPDATE ON public."RecoverySession" TO invitation_protocol_owner_NOLOGIN;
GRANT USAGE ON SCHEMA public TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public.gen_random_bytes(INTEGER),public.digest(BYTEA,TEXT),public.hmac(BYTEA,BYTEA,TEXT) TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public.write_global_security_event(TEXT,TEXT,TEXT,TEXT) TO invitation_protocol_owner_NOLOGIN;
-- Canonical guard triggers on the bridged relations are security invoker, so they execute as the
-- invitation protocol owner. Several are deferred constraint triggers that only fire at commit.
GRANT EXECUTE ON FUNCTION public."assert_global_security_binding_current_authorization"(TEXT,TEXT,TEXT,TEXT,"GlobalSecurityOperationKey",INTEGER,INTEGER) TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."assert_global_security_stale_finalization"(TEXT,TEXT,TEXT,TEXT,"GlobalSecurityOperationKey",INTEGER,INTEGER) TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."assert_recovery_code_set_issuance_authorization"(TEXT,TEXT,TEXT,INTEGER,INTEGER,"FreshAuthGrantState") TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."assert_recovery_session_expiry_finalization"(TEXT,TEXT,TEXT) TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."assert_session_revoke_success_finalization"(TEXT,TEXT,"GlobalSecurityOperationBinding") TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."global_security_terminal_outcome_valid"("GlobalSecurityOperationKey","GlobalSecurityOperationStatus",TEXT) TO invitation_protocol_owner_NOLOGIN;
GRANT EXECUTE ON FUNCTION public."lock_global_security_operation_identity_v1"(TEXT,TEXT) TO invitation_protocol_owner_NOLOGIN;

REVOKE ALL ON SCHEMA invitation_protocol FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA invitation_protocol FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA invitation_protocol FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA invitation_protocol FROM PUBLIC;
REVOKE ALL ON TABLE public."FreshAuthAttestationKey",public."RecoveryCodeSet",public."RecoveryCode",public."Invite",public."HouseholdMember",public."User",public."Account",public."AccountSecurityState",public."AuditEvent" FROM PUBLIC;

DO $$
DECLARE role_name TEXT; procedure_name TEXT; runtime_procedures TEXT[]:=ARRAY['claim_invitation_presentation_v2','close_invitation_presentation_v2','reserve_manual_invite_create_v2','submit_manual_invite_create_v2','status_manual_invite_create_v2','abandon_manual_invite_create_v2','reserve_manual_invite_replace_v2','submit_manual_invite_replace_v2','status_manual_invite_replace_v2','abandon_manual_invite_replace_v2','reserve_invitation_credential_setup_v2','submit_invitation_credential_setup_v2','status_invitation_credential_setup_v2','abandon_invitation_credential_setup_v2','reserve_invitation_recovery_enrollment_v2','authorize_invitation_recovery_enrollment_fresh_auth_v2','bind_invitation_recovery_enrollment_fresh_auth_v2','submit_invitation_recovery_enrollment_v2','status_invitation_recovery_enrollment_v2','abandon_invitation_recovery_enrollment_v2','reserve_invitation_recovery_rehearsal_v2','submit_invitation_recovery_rehearsal_v2','status_invitation_recovery_rehearsal_v2','abandon_invitation_recovery_rehearsal_v2','bind_post_signin_invitation_claim_v2','issue_invitation_review_v2','reserve_invitation_acceptance_v2','submit_invitation_acceptance_v2','status_invitation_acceptance_v2','abandon_invitation_acceptance_v2','revoke_invitation_v2','revoke_all_invitations_v2'];
BEGIN
  FOREACH role_name IN ARRAY ARRAY['cubby_invitation_runtime','cubby_invitation_expiry_worker','cubby_invitation_maintenance_worker','cubby_runtime','cubby_auth','cubby_email_delivery'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA invitation_protocol FROM %I',role_name);
      -- Direct public-relation denial is scoped to the execute-only invitation roles.
      IF role_name=ANY(ARRAY['cubby_invitation_runtime','cubby_invitation_expiry_worker','cubby_invitation_maintenance_worker']) THEN
        EXECUTE format('REVOKE ALL ON TABLE public."FreshAuthAttestationKey",public."RecoveryCodeSet",public."RecoveryCode",public."Invite",public."HouseholdMember",public."User",public."Account",public."AccountSecurityState",public."AuditEvent" FROM %I',role_name);
      END IF;
      -- Invitation-schema execution remains denied by default for every login role.
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA invitation_protocol FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_invitation_runtime') THEN
    GRANT USAGE ON SCHEMA invitation_protocol TO cubby_invitation_runtime;
    FOR procedure_name IN SELECT p.oid::regprocedure::TEXT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND p.proname=ANY(runtime_procedures) LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cubby_invitation_runtime',procedure_name);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_invitation_expiry_worker') THEN GRANT USAGE ON SCHEMA invitation_protocol TO cubby_invitation_expiry_worker; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_invitation_maintenance_worker') THEN GRANT USAGE ON SCHEMA invitation_protocol TO cubby_invitation_maintenance_worker; END IF;
END $$;

GRANT EXECUTE ON FUNCTION invitation_protocol.expire_invitation_v2(TEXT,TIMESTAMPTZ,invitation_protocol.invitation_expiry_worker_carrier) TO cubby_invitation_expiry_worker;
GRANT EXECUTE ON FUNCTION invitation_protocol.classify_invitation_setup_corridor_v2(TEXT,invitation_protocol.invitation_setup_corridor_attestation) TO cubby_invitation_runtime;
GRANT EXECUTE ON FUNCTION invitation_protocol.compact_invitation_operation_v2(UUID,invitation_protocol.invitation_maintenance_worker_carrier) TO cubby_invitation_maintenance_worker;

REVOKE ALL ON FUNCTION invitation_protocol.write_invitation_audit_v2(TEXT,UUID,invitation_protocol.invitation_audit_action,JSONB,invitation_protocol.invitation_owner_private_call_attestation) FROM PUBLIC;
REVOKE ALL ON FUNCTION invitation_protocol.write_invitation_audit_v2(TEXT,UUID,invitation_protocol.invitation_audit_action,JSONB,invitation_protocol.invitation_owner_private_call_attestation) FROM cubby_invitation_runtime,cubby_invitation_expiry_worker,cubby_invitation_maintenance_worker,cubby_runtime,cubby_auth,cubby_email_delivery;
REVOKE ALL ON FUNCTION invitation_protocol.verify_invitation_recovery_rehearsal_attestation_v1(TEXT,TEXT,UUID,UUID,INTEGER,INTEGER,INTEGER,TEXT,BYTEA,INTEGER,BYTEA,BYTEA,BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION invitation_protocol.verify_invitation_recovery_rehearsal_attestation_v1(TEXT,TEXT,UUID,UUID,INTEGER,INTEGER,INTEGER,TEXT,BYTEA,INTEGER,BYTEA,BYTEA,BYTEA) FROM cubby_invitation_runtime,cubby_invitation_expiry_worker,cubby_invitation_maintenance_worker,cubby_runtime,cubby_auth,cubby_email_delivery;


-- A deferred constraint trigger fires at COMMIT, outside the calling definer procedure, so
-- CURRENT_USER is the session role. The invitation login roles are execute-only with no table
-- rights, so these security-invoker guards could not read the relations they validate. They become
-- definer with a pinned search path, matching the finalization guards the throttle-core migration
-- already altered the same way. They remain read-only assertions that still raise on violation.
ALTER FUNCTION public."enforce_recovery_code_set_exact_ten"() SECURITY DEFINER;
ALTER FUNCTION public."enforce_recovery_code_set_issuance_finalization"() SECURITY DEFINER;
ALTER FUNCTION public."enforce_recovery_session_consumption_binding"() SECURITY DEFINER;

-- Canonical trigger functions on the bridged relations inherit the caller's search path. Invitation
-- procedures run under pg_catalog,invitation_protocol, so the invoked graph is pinned to its own path.
ALTER FUNCTION public."enforce_account_security_version_transition"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_email_change_cutover_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_email_change_stale_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_global_security_binding_write_once"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_global_security_operation_write_once"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_password_change_stale_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_password_change_success_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_code_initial_state"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_code_set_exact_ten"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_code_set_issuance_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_code_set_transition"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_code_transition"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_enrollment_failure_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_enrollment_success_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_reset_success_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_reset_terminal_closure"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_session_consumption_binding"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_session_expiry_finalization"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."enforce_recovery_session_transition"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."guard_global_security_event_insert"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."guard_global_security_operation_insert"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."guard_user_email_change"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."lock_global_security_transition_v1"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."prevent_global_security_event_mutation"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."prevent_global_security_retention_delete"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."prevent_global_security_retention_truncate"() SET search_path = pg_catalog, public;

COMMIT;
