-- Privileged assisted credential persistence and mutation boundary.
-- The enum values used here were committed by the preceding migration.
BEGIN;

CREATE TABLE public."AssistedCredentialMutation" (
  "householdId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operationKey" public."BrowserOperationKey" NOT NULL,
  "browserBindingId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorSessionId" TEXT NOT NULL,
  "actorMemberId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "targetMemberId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "openingFingerprint" TEXT NOT NULL,
  "intentFingerprint" TEXT NOT NULL,
  "oldCredentialVersion" INTEGER,
  "newCredentialVersion" INTEGER NOT NULL,
  "oldSessionSecurityVersion" INTEGER,
  "newSessionSecurityVersion" INTEGER NOT NULL,
  "passwordHashDigest" BYTEA NOT NULL,
  "requireFirstLoginPasswordChange" BOOLEAN NOT NULL,
  "attestationNonce" BYTEA NOT NULL,
  "attestationKeyVersion" INTEGER NOT NULL,
  "attestationIssuedAt" TIMESTAMP(3) NOT NULL,
  "attestationMacDigest" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AssistedCredentialMutation_pkey" PRIMARY KEY ("householdId","operationId"),
  CONSTRAINT "AssistedCredentialMutation_browserBindingId_key" UNIQUE ("browserBindingId"),
  CONSTRAINT "AssistedCredentialMutation_attestationNonce_key" UNIQUE ("attestationNonce"),
  CONSTRAINT "AssistedCredentialMutation_operation_key_check" CHECK (
    "operationKey" IN ('member.account.create'::public."BrowserOperationKey",'member.password.reset'::public."BrowserOperationKey")
  ),
  CONSTRAINT "AssistedCredentialMutation_operation_id_check" CHECK ("operationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
  CONSTRAINT "AssistedCredentialMutation_fingerprint_check" CHECK (
    "openingFingerprint" ~ '^[0-9a-f]{64}$' AND "intentFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AssistedCredentialMutation_digest_check" CHECK (
    octet_length("passwordHashDigest")=32 AND octet_length("attestationNonce")=32
      AND octet_length("attestationMacDigest")=32 AND "attestationKeyVersion">0
  ),
  CONSTRAINT "AssistedCredentialMutation_version_check" CHECK (
    "newCredentialVersion">0 AND "newSessionSecurityVersion">0
      AND ("oldCredentialVersion" IS NULL OR "oldCredentialVersion">0)
      AND ("oldSessionSecurityVersion" IS NULL OR "oldSessionSecurityVersion">0)
      AND (
        ("operationKey"='member.account.create'::public."BrowserOperationKey"
          AND "oldCredentialVersion" IS NULL AND "oldSessionSecurityVersion" IS NULL
          AND "newCredentialVersion"=1 AND "newSessionSecurityVersion"=1)
        OR
        ("operationKey"='member.password.reset'::public."BrowserOperationKey"
          AND "oldCredentialVersion" IS NOT NULL AND "oldSessionSecurityVersion" IS NOT NULL
          AND "newCredentialVersion"="oldCredentialVersion"+1
          AND "newSessionSecurityVersion"="oldSessionSecurityVersion"+1)
      )
  ),
  CONSTRAINT "AssistedCredentialMutation_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AssistedCredentialMutation_targetUserId_createdAt_idx"
  ON public."AssistedCredentialMutation"("targetUserId","createdAt");
CREATE INDEX "AssistedCredentialMutation_targetMemberId_idx"
  ON public."AssistedCredentialMutation"("targetMemberId");

CREATE TABLE public."AssistedAccountState" (
  "userId" TEXT NOT NULL,
  "assistedCreationHouseholdId" TEXT,
  "assistedCreationMemberId" TEXT,
  "assistedCreationOperationId" TEXT,
  "requiredChangeCredentialVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AssistedAccountState_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "AssistedAccountState_origin_key" UNIQUE ("assistedCreationHouseholdId","assistedCreationOperationId"),
  CONSTRAINT "AssistedAccountState_origin_shape_check" CHECK (
    ("assistedCreationHouseholdId" IS NULL AND "assistedCreationMemberId" IS NULL AND "assistedCreationOperationId" IS NULL)
    OR
    ("assistedCreationHouseholdId" IS NOT NULL AND "assistedCreationMemberId" IS NOT NULL
      AND "assistedCreationOperationId" IS NOT NULL
      AND "assistedCreationOperationId" ~ '^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$')
  ),
  CONSTRAINT "AssistedAccountState_required_version_check" CHECK (
    "requiredChangeCredentialVersion" IS NULL OR "requiredChangeCredentialVersion">0
  ),
  CONSTRAINT "AssistedAccountState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- These identifiers are historical evidence. Only the target User is a live FK.
CREATE FUNCTION public."prevent_assisted_credential_mutation_change_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM public."User" WHERE "id"=OLD."targetUserId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'assisted_credential_mutation_immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION public."reset_assisted_member_password_v1"(
  scope_actor_user_id TEXT,scope_actor_session_id TEXT,scope_actor_member_id TEXT,scope_household_id TEXT,
  scope_operation_id TEXT,scope_opening_fingerprint TEXT,scope_intent_fingerprint TEXT,scope_target_member_id TEXT,
  scope_expected_credential_version INTEGER,scope_expected_session_security_version INTEGER,
  scope_replacement_password_hash TEXT,scope_replacement_password_hash_digest BYTEA,
  scope_require_first_change BOOLEAN,scope_attestation_key_version INTEGER,scope_attestation_nonce BYTEA,
  scope_attestation_issued_at TIMESTAMP,scope_attestation_mac BYTEA
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_session public."Session"%ROWTYPE; actor_member public."HouseholdMember"%ROWTYPE;
  actor_activity public."SessionSecurityActivity"%ROWTYPE; actor_security public."AccountSecurityState"%ROWTYPE;
  actor_assisted public."AssistedAccountState"%ROWTYPE; target_member public."HouseholdMember"%ROWTYPE;
  target_user public."User"%ROWTYPE; target_security public."AccountSecurityState"%ROWTYPE;
  target_account public."Account"%ROWTYPE; target_assisted public."AssistedAccountState"%ROWTYPE;
  platform_authority public."PlatformAuthority"%ROWTYPE; platform_settings public."PlatformSettings"%ROWTYPE;
  household_row public."Household"%ROWTYPE; binding_row public."BrowserOperationBinding"%ROWTYPE;
  key_row public."FreshAuthAttestationKey"%ROWTYPE; recovery_row public."RecoverySession"%ROWTYPE;
  target_user_id TEXT; now_time TIMESTAMP(3):=date_trunc('milliseconds',clock_timestamp());
  replacement_digest BYTEA; new_values_frame BYTEA; new_values_digest BYTEA; attestation_frame BYTEA; expected_mac BYTEA;
  privacy_denied BOOLEAN:=false; stale_revision BOOLEAN:=false;
BEGIN
  PERFORM public."acquire_assisted_credential_fence_v1"();
  SELECT candidate."targetSnapshot"->>'targetUserId' INTO target_user_id
    FROM public."BrowserOperationBinding" candidate
    WHERE candidate."householdId"=scope_household_id AND candidate."operationId"=scope_operation_id;
  SELECT * INTO target_member FROM public."HouseholdMember" WHERE "id"=scope_target_member_id;
  IF target_user_id IS NULL THEN target_user_id:=target_member."userId"; END IF;

  SELECT * INTO platform_authority FROM public."PlatformAuthority" WHERE "id"='platform' FOR SHARE NOWAIT;
  SELECT * INTO platform_settings FROM public."PlatformSettings" WHERE "id"='platform' FOR SHARE NOWAIT;
  PERFORM 1 FROM public."User" WHERE "id" IN (scope_actor_user_id,target_user_id) ORDER BY "id" FOR KEY SHARE NOWAIT;
  SELECT * INTO target_user FROM public."User" WHERE "id"=target_user_id;
  PERFORM 1 FROM public."AccountSecurityState" WHERE "userId" IN (scope_actor_user_id,target_user_id) ORDER BY "userId" FOR UPDATE NOWAIT;
  SELECT * INTO actor_security FROM public."AccountSecurityState" WHERE "userId"=scope_actor_user_id;
  SELECT * INTO target_security FROM public."AccountSecurityState" WHERE "userId"=target_user_id;
  SELECT * INTO actor_assisted FROM public."AssistedAccountState" WHERE "userId"=scope_actor_user_id FOR SHARE NOWAIT;
  SELECT * INTO target_assisted FROM public."AssistedAccountState" WHERE "userId"=target_user_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."Account" WHERE "userId" IN (scope_actor_user_id,target_user_id) AND "providerId"='credential' ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO target_account FROM public."Account" WHERE "userId"=target_user_id AND "providerId"='credential';
  PERFORM 1 FROM public."Session" WHERE "id"=scope_actor_session_id OR "userId"=target_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM public."lock_actor_session_for_assisted_operation_nowait"(scope_actor_user_id,scope_actor_session_id);
  PERFORM public."lock_user_sessions_for_assisted_operation_nowait"(target_user_id);
  SELECT * INTO actor_session FROM public."Session" WHERE "id"=scope_actor_session_id;
  PERFORM 1 FROM public."SessionSecurityActivity" WHERE "userId" IN (scope_actor_user_id,target_user_id) ORDER BY "sessionId" FOR UPDATE NOWAIT;
  SELECT * INTO actor_activity FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_actor_session_id;
  PERFORM 1 FROM public."FreshAuthGrant" WHERE "userId" IN (scope_actor_user_id,target_user_id) ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_attestation_key_version FOR SHARE NOWAIT;
  PERFORM 1 FROM public."RecoverySession" WHERE "userId"=target_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperationBinding" WHERE "userId"=target_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperation" WHERE "userId"=target_user_id ORDER BY "userId","operationId" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."HouseholdMember"
    WHERE "id"=scope_actor_member_id OR "userId"=target_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO actor_member FROM public."HouseholdMember" WHERE "id"=scope_actor_member_id;
  SELECT * INTO target_member FROM public."HouseholdMember" WHERE "id"=scope_target_member_id;
  PERFORM 1 FROM public."Household" WHERE "id"=scope_household_id
    OR "id" IN (SELECT foreign_member."householdId" FROM public."HouseholdMember" foreign_member
      WHERE foreign_member."userId"=target_user_id AND foreign_member."deletedAt" IS NULL)
    ORDER BY "id" FOR KEY SHARE NOWAIT;
  SELECT * INTO household_row FROM public."Household" WHERE "id"=scope_household_id;
  PERFORM public."try_lock_assisted_browser_identity_v1"(scope_household_id,scope_operation_id);
  SELECT * INTO binding_row FROM public."BrowserOperationBinding"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR UPDATE NOWAIT;

  IF platform_authority."id" IS NULL OR platform_settings."id" IS NULL OR household_row."id" IS NULL
    OR household_row."deletedAt" IS NOT NULL OR actor_session."id" IS NULL
    OR actor_member."id" IS NULL OR actor_member."householdId"<>scope_household_id
    OR actor_member."userId"<>actor_session."userId" OR actor_session."userId"<>scope_actor_user_id
    OR actor_member."disabledAt" IS NOT NULL OR actor_member."deletedAt" IS NOT NULL
    OR actor_security."userId" IS NULL OR actor_activity."sessionId" IS NULL OR actor_activity."state"<>'active'
    OR actor_activity."issuanceSessionSecurityVersion"<>actor_security."sessionSecurityVersion"
    OR actor_assisted."requiredChangeCredentialVersion" IS NOT NULL OR actor_member."role" NOT IN ('owner','admin')
    OR EXISTS (SELECT 1 FROM invitation_protocol."InvitationAccountSetup" setup
      WHERE setup."userId"=scope_actor_user_id AND setup."accountOrigin"='invitation_created' AND setup."setupState"<>'accepted')
  THEN RAISE EXCEPTION 'assisted_actor_not_authorized' USING ERRCODE='42501'; END IF;

  IF binding_row."id" IS NULL OR binding_row."sessionId"<>scope_actor_session_id
    OR binding_row."actorUserId"<>scope_actor_user_id OR binding_row."actorMemberId"<>scope_actor_member_id
    OR binding_row."operationKey"<>'member.password.reset'::public."BrowserOperationKey"
    OR binding_row."persistenceVersion"<>2 OR binding_row."protocolVersion"<>'browser_v2'
    OR binding_row."openingFingerprint" IS DISTINCT FROM scope_opening_fingerprint OR binding_row."state"<>'open'
    OR binding_row."expiresAt"<=clock_timestamp() OR binding_row."targetKind" IS DISTINCT FROM 'member'
    OR binding_row."targetId" IS DISTINCT FROM scope_target_member_id OR binding_row."babyId" IS NOT NULL
    OR binding_row."targetSnapshot"->>'householdId' IS DISTINCT FROM scope_household_id
    OR binding_row."targetSnapshot"->>'actorMemberId' IS DISTINCT FROM scope_actor_member_id
    OR binding_row."targetSnapshot"->>'targetMemberId' IS DISTINCT FROM scope_target_member_id
    OR binding_row."targetSnapshot"->>'targetUserId' IS DISTINCT FROM target_user_id
  THEN RAISE EXCEPTION 'assisted_browser_binding_invalid' USING ERRCODE='23514'; END IF;

  IF scope_replacement_password_hash IS NULL OR scope_replacement_password_hash!~'^[0-9a-f]{16,}:[0-9a-f]{32,}$'
    OR scope_replacement_password_hash_digest IS NULL OR octet_length(scope_replacement_password_hash_digest)<>32
    OR scope_attestation_nonce IS NULL OR octet_length(scope_attestation_nonce)<>32
    OR scope_attestation_mac IS NULL OR octet_length(scope_attestation_mac)<>32
    OR scope_expected_credential_version IS NULL OR scope_expected_session_security_version IS NULL
    OR scope_require_first_change IS NULL
    OR scope_attestation_issued_at IS NULL OR scope_attestation_key_version IS NULL
    OR scope_attestation_issued_at<>date_trunc('milliseconds',scope_attestation_issued_at)
    OR scope_attestation_issued_at>clock_timestamp()+INTERVAL '5 seconds'
    OR scope_attestation_issued_at<=clock_timestamp()-INTERVAL '10 minutes'
  THEN RAISE EXCEPTION 'assisted_credential_attestation_invalid' USING ERRCODE='22023'; END IF;
  IF key_row."keyVersion" IS NULL OR key_row."active" IS NOT TRUE
    OR (key_row."rotatedAt" IS NOT NULL AND key_row."rotatedAt"<=clock_timestamp()-INTERVAL '10 minutes')
  THEN RAISE EXCEPTION 'assisted_credential_attestation_key_invalid' USING ERRCODE='42501'; END IF;
  replacement_digest:=digest(convert_to(scope_replacement_password_hash,'UTF8'),'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(replacement_digest,scope_replacement_password_hash_digest)
  THEN RAISE EXCEPTION 'assisted_replacement_digest_invalid' USING ERRCODE='22023'; END IF;
  new_values_frame:=int4send(octet_length(convert_to(target_user_id,'UTF8')))||convert_to(target_user_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_target_member_id,'UTF8')))||convert_to(scope_target_member_id,'UTF8')
    ||CASE WHEN scope_require_first_change THEN decode('01','hex') ELSE decode('00','hex') END;
  new_values_digest:=digest(new_values_frame,'sha256');
  attestation_frame:=convert_to('cubby.admin-assisted-credential-mutation.v1','UTF8')
    ||int4send(octet_length(convert_to('member_password_reset','UTF8')))||convert_to('member_password_reset','UTF8')
    ||int4send(octet_length(convert_to(scope_actor_user_id,'UTF8')))||convert_to(scope_actor_user_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_actor_session_id,'UTF8')))||convert_to(scope_actor_session_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_actor_member_id,'UTF8')))||convert_to(scope_actor_member_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_household_id,'UTF8')))||convert_to(scope_household_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_operation_id,'UTF8')))||convert_to(scope_operation_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_opening_fingerprint,'UTF8')))||convert_to(scope_opening_fingerprint,'UTF8')
    ||int4send(octet_length(convert_to(scope_intent_fingerprint,'UTF8')))||convert_to(scope_intent_fingerprint,'UTF8')
    ||int4send(octet_length(scope_replacement_password_hash_digest))||scope_replacement_password_hash_digest
    ||int4send(octet_length(new_values_digest))||new_values_digest
    ||int8send(scope_expected_credential_version::bigint)||int8send(scope_expected_session_security_version::bigint)
    ||timestamp_send(scope_attestation_issued_at)
    ||int4send(octet_length(scope_attestation_nonce))||scope_attestation_nonce||int4send(scope_attestation_key_version);
  expected_mac:=public.hmac(attestation_frame,key_row."verificationKey",'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(expected_mac,scope_attestation_mac)
    OR EXISTS (SELECT 1 FROM public."AssistedCredentialMutation" WHERE "attestationNonce"=scope_attestation_nonce)
  THEN RAISE EXCEPTION 'assisted_credential_attestation_mac_invalid' USING ERRCODE='42501'; END IF;

  INSERT INTO public."BrowserMutationOperation"("bindingId","householdId","operationId","operationKey","actorUserId","actorMemberId",
    "openingFingerprint","intentFingerprint","persistenceVersion","targetKind","targetId","babyId","status","createdAt","updatedAt")
  VALUES(binding_row."id",scope_household_id,scope_operation_id,'member.password.reset',scope_actor_user_id,scope_actor_member_id,
    scope_opening_fingerprint,scope_intent_fingerprint,2,'member',scope_target_member_id,NULL,'pending',now_time,now_time);
  UPDATE public."BrowserOperationBinding" SET "state"='submitted',"updatedAt"=now_time WHERE "id"=binding_row."id";

  privacy_denied:=target_user."id" IS NULL OR target_member."id" IS NULL
    OR target_member."householdId"<>scope_household_id OR target_member."userId"<>target_user_id
    OR target_member."deletedAt" IS NOT NULL OR target_member."role"='owner'
    OR target_user."id"=actor_session."userId" OR platform_authority."ownerUserId"=target_user_id
    OR (actor_member."role"='admin' AND target_member."role" NOT IN ('parent','caretaker','read_only'))
    OR EXISTS (SELECT 1 FROM public."HouseholdMember" foreign_member
      WHERE foreign_member."userId"=target_user_id AND foreign_member."householdId"<>scope_household_id
        AND foreign_member."deletedAt" IS NULL);
  IF privacy_denied OR target_account."id" IS NULL OR target_account."password" IS NULL THEN
    UPDATE public."BrowserMutationOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeKind"='member_password',
      "outcomeCode"='personal_recovery_unavailable',"outcomeSnapshot"=NULL,"terminalAt"=now_time,"updatedAt"=now_time
      WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
    UPDATE public."BrowserOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
    RETURN jsonb_build_object('operationId',scope_operation_id,'status','rejected','outcomeCode','personal_recovery_unavailable');
  END IF;

  stale_revision:=target_security."credentialVersion"<>scope_expected_credential_version
    OR target_security."sessionSecurityVersion"<>scope_expected_session_security_version
    OR binding_row."targetSnapshot"->>'actorRole'<>actor_member."role"::text
    OR binding_row."targetSnapshot"->>'targetRole'<>target_member."role"::text
    OR binding_row."targetSnapshot"->>'credentialVersion'<>scope_expected_credential_version::text
    OR binding_row."targetSnapshot"->>'sessionSecurityVersion'<>scope_expected_session_security_version::text
    OR binding_row."targetSnapshot"->>'actorMembershipUpdatedAt'<>
      to_char(actor_member."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR binding_row."targetSnapshot"->>'targetMembershipUpdatedAt'<>
      to_char(target_member."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR binding_row."targetSnapshot"->>'platformAuthorityUpdatedAt'<>
      to_char(platform_authority."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  IF stale_revision THEN
    UPDATE public."BrowserMutationOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeKind"='member_password',
      "outcomeCode"='stale_revision',"outcomeSnapshot"=NULL,"terminalAt"=now_time,"updatedAt"=now_time
      WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
    UPDATE public."BrowserOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
    RETURN jsonb_build_object('operationId',scope_operation_id,'status','stale','outcomeCode','stale_revision');
  END IF;

  UPDATE public."AccountSecurityState" SET
    "credentialVersion"="credentialVersion"+1,"sessionSecurityVersion"="sessionSecurityVersion"+1,
    "lastCredentialOperationId"=scope_operation_id,"lastSessionSecurityOperationId"=scope_operation_id,"securityUpdatedAt"=now_time
    WHERE "userId"=target_user_id AND "credentialVersion"=scope_expected_credential_version
      AND "sessionSecurityVersion"=scope_expected_session_security_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'assisted_reset_security_state_changed' USING ERRCODE='40001'; END IF;
  UPDATE public."Account" SET "password"=scope_replacement_password_hash,"updatedAt"=now_time
    WHERE "id"=target_account."id" AND "userId"=target_user_id AND "providerId"='credential';
  IF NOT FOUND THEN RAISE EXCEPTION 'assisted_reset_credential_missing'; END IF;
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=now_time
    WHERE "userId"=target_user_id AND "state"='active';
  UPDATE public."FreshAuthGrant" SET "state"='revoked',"revokedAt"=now_time
    WHERE "userId"=target_user_id AND "state"='issued';
  DELETE FROM public."Session" WHERE "userId"=target_user_id;

  FOR recovery_row IN SELECT * FROM public."RecoverySession"
    WHERE "userId"=target_user_id AND "state"='restricted' ORDER BY "id"
  LOOP
    UPDATE public."GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,
      "outcomeCode"='stale_security_version',"outcomeSnapshot"='{}'::jsonb,"terminalAt"=now_time,"updatedAt"=now_time
      WHERE "userId"=target_user_id AND "operationId"=recovery_row."operationId" AND "status" IN ('pending','unknown');
    IF NOT FOUND THEN RAISE EXCEPTION 'assisted_reset_recovery_operation_invalid'; END IF;
    UPDATE public."GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=now_time
      WHERE "userId"=target_user_id AND "operationId"=recovery_row."operationId" AND "state"='submitted';
    IF NOT FOUND THEN RAISE EXCEPTION 'assisted_reset_recovery_binding_invalid'; END IF;
    UPDATE public."RecoverySession" SET "state"='closed',"closedAt"=now_time
      WHERE "id"=recovery_row."id" AND "state"='restricted';
    IF NOT FOUND THEN RAISE EXCEPTION 'assisted_reset_recovery_session_invalid'; END IF;
    INSERT INTO public."GlobalSecurityEvent"("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt")
      VALUES('gse_assisted_'||encode(gen_random_bytes(16),'hex'),target_user_id,'operation_outcome','stale_security_version',
        recovery_row."operationId",NULL,'{}'::jsonb,now_time);
  END LOOP;

  INSERT INTO public."AssistedCredentialMutation"("householdId","operationId","operationKey","browserBindingId","actorUserId","actorSessionId",
    "actorMemberId","targetUserId","targetMemberId","accountId","openingFingerprint","intentFingerprint","oldCredentialVersion",
    "newCredentialVersion","oldSessionSecurityVersion","newSessionSecurityVersion","passwordHashDigest","requireFirstLoginPasswordChange",
    "attestationNonce","attestationKeyVersion","attestationIssuedAt","attestationMacDigest","createdAt")
  VALUES(scope_household_id,scope_operation_id,'member.password.reset',binding_row."id",scope_actor_user_id,scope_actor_session_id,
    scope_actor_member_id,target_user_id,scope_target_member_id,target_account."id",scope_opening_fingerprint,scope_intent_fingerprint,
    scope_expected_credential_version,scope_expected_credential_version+1,scope_expected_session_security_version,
    scope_expected_session_security_version+1,replacement_digest,scope_require_first_change,scope_attestation_nonce,
    scope_attestation_key_version,scope_attestation_issued_at,digest(scope_attestation_mac,'sha256'),now_time);
  IF target_assisted."userId" IS NULL THEN
    INSERT INTO public."AssistedAccountState"("userId","assistedCreationHouseholdId","assistedCreationMemberId","assistedCreationOperationId",
      "requiredChangeCredentialVersion","createdAt","updatedAt")
    VALUES(target_user_id,NULL,NULL,NULL,CASE WHEN scope_require_first_change THEN scope_expected_credential_version+1 ELSE NULL END,now_time,now_time);
  ELSE
    UPDATE public."AssistedAccountState" SET "requiredChangeCredentialVersion"=
      CASE WHEN scope_require_first_change THEN scope_expected_credential_version+1 ELSE NULL END,"updatedAt"=now_time
      WHERE "userId"=target_user_id;
  END IF;
  PERFORM public."write_assisted_account_audit_v1"(scope_household_id,scope_actor_user_id,scope_actor_member_id,
    scope_target_member_id,scope_operation_id,'member.password.reset','reset',now_time);
  UPDATE public."BrowserMutationOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeKind"='member_password',
    "outcomeCode"='reset',"outcomeSnapshot"=jsonb_build_object('memberId',scope_target_member_id),"auditCorrelation"=scope_operation_id,
    "terminalAt"=now_time,"updatedAt"=now_time WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  UPDATE public."BrowserOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
  RETURN jsonb_build_object('operationId',scope_operation_id,'status','completed','outcomeCode','reset','memberId',scope_target_member_id);
END $$;

CREATE FUNCTION public."prevent_assisted_retention_truncate_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'assisted_retention_delete_forbidden' USING ERRCODE='55000';
END $$;

CREATE TRIGGER "AssistedCredentialMutation_immutable"
BEFORE UPDATE OR DELETE ON public."AssistedCredentialMutation"
FOR EACH ROW EXECUTE FUNCTION public."prevent_assisted_credential_mutation_change_v1"();
CREATE TRIGGER "AssistedCredentialMutation_retention_truncate_guard"
BEFORE TRUNCATE ON public."AssistedCredentialMutation"
FOR EACH STATEMENT EXECUTE FUNCTION public."prevent_assisted_retention_truncate_v1"();
CREATE TRIGGER "AssistedAccountState_retention_truncate_guard"
BEFORE TRUNCATE ON public."AssistedAccountState"
FOR EACH STATEMENT EXECUTE FUNCTION public."prevent_assisted_retention_truncate_v1"();

CREATE FUNCTION public."enforce_assisted_account_state_transition_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  security_state public."AccountSecurityState"%ROWTYPE;
  password_receipt public."PasswordChangeCredentialMutation"%ROWTYPE;
  operation_row public."GlobalSecurityOperation"%ROWTYPE;
  binding_row public."GlobalSecurityOperationBinding"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public."User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'assisted_retention_delete_forbidden' USING ERRCODE='55000';
  END IF;

  IF TG_OP='UPDATE' AND ROW(NEW."assistedCreationHouseholdId",NEW."assistedCreationMemberId",NEW."assistedCreationOperationId",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."assistedCreationHouseholdId",OLD."assistedCreationMemberId",OLD."assistedCreationOperationId",OLD."createdAt")
  THEN RAISE EXCEPTION 'assisted_account_state_origin_immutable' USING ERRCODE='55000'; END IF;

  SELECT * INTO security_state FROM public."AccountSecurityState"
  WHERE "userId"=NEW."userId" FOR SHARE;
  IF security_state."userId" IS NULL THEN RAISE EXCEPTION 'assisted_account_state_security_state_missing'; END IF;

  -- A credential-version writer must preserve a nonnull obligation by rebinding it.
  IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND OLD."requiredChangeCredentialVersion" IS NOT NULL
    AND NEW."requiredChangeCredentialVersion"=security_state."credentialVersion"+1
  THEN RETURN NEW; END IF;

  -- Assisted create/reset may select or clear only the value attested by its just-inserted receipt.
  IF EXISTS (
    SELECT 1 FROM public."AssistedCredentialMutation" receipt
    WHERE receipt."targetUserId"=NEW."userId"
      AND receipt."newCredentialVersion"=security_state."credentialVersion"
      AND security_state."lastCredentialOperationId"=receipt."operationId"
      AND NEW."requiredChangeCredentialVersion" IS NOT DISTINCT FROM
        CASE WHEN receipt."requireFirstLoginPasswordChange" THEN receipt."newCredentialVersion" ELSE NULL END
      AND (
        (receipt."operationKey"='member.account.create'::public."BrowserOperationKey"
          AND NEW."assistedCreationHouseholdId"=receipt."householdId"
          AND NEW."assistedCreationMemberId"=receipt."targetMemberId"
          AND NEW."assistedCreationOperationId"=receipt."operationId")
        OR
        (receipt."operationKey"='member.password.reset'::public."BrowserOperationKey"
          AND (TG_OP='UPDATE' OR (NEW."assistedCreationHouseholdId" IS NULL
            AND NEW."assistedCreationMemberId" IS NULL AND NEW."assistedCreationOperationId" IS NULL)))
      )
  ) THEN RETURN NEW; END IF;

  -- Canonical self-password change has no hash field in its existing receipt. Prove its real
  -- mutation, completed operation, terminal binding, account and version attribution instead.
  IF TG_OP='UPDATE' AND OLD."requiredChangeCredentialVersion" IS NOT NULL
    AND NEW."requiredChangeCredentialVersion" IS NULL
  THEN
    SELECT * INTO password_receipt FROM public."PasswordChangeCredentialMutation"
      WHERE "userId"=NEW."userId" AND "operationId"=security_state."lastCredentialOperationId";
    SELECT * INTO operation_row FROM public."GlobalSecurityOperation"
      WHERE "userId"=NEW."userId" AND "operationId"=password_receipt."operationId";
    SELECT * INTO binding_row FROM public."GlobalSecurityOperationBinding"
      WHERE "id"=operation_row."bindingId";
    IF password_receipt."userId" IS NOT NULL
      AND operation_row."operationKey"='password_change'
      AND operation_row."status"='completed' AND operation_row."outcomeCode"='changed'
      AND binding_row."state"='terminal'
      AND security_state."credentialVersion"=OLD."requiredChangeCredentialVersion"
      AND EXISTS (SELECT 1 FROM public."Account" account_row
        WHERE account_row."id"=password_receipt."accountId" AND account_row."userId"=NEW."userId"
          AND account_row."providerId"='credential' AND account_row."password" IS NOT NULL)
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'assisted_account_state_transition_forbidden' USING ERRCODE='55000';
END $$;

CREATE TRIGGER "AssistedAccountState_transition_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."AssistedAccountState"
FOR EACH ROW EXECUTE FUNCTION public."enforce_assisted_account_state_transition_v1"();

-- Extend the canonical version guard: any credential advance first rebinds a nonnull obligation.
CREATE OR REPLACE FUNCTION public."enforce_account_security_version_transition"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public."User" WHERE "id"=OLD."userId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'account_security_state_delete_forbidden';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."credentialVersion"<>1 OR NEW."sessionSecurityVersion"<>1 THEN
      RAISE EXCEPTION 'account_security_state_initial_version_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'account_security_state_identity_immutable'; END IF;
  IF NEW."credentialVersion"<OLD."credentialVersion" OR NEW."sessionSecurityVersion"<OLD."sessionSecurityVersion" THEN
    RAISE EXCEPTION 'account_security_version_regression';
  END IF;
  IF (NEW."credentialVersion">OLD."credentialVersion" AND (NEW."lastCredentialOperationId" IS NULL OR NEW."lastCredentialOperationId" IS NOT DISTINCT FROM OLD."lastCredentialOperationId"))
    OR (NEW."credentialVersion"=OLD."credentialVersion" AND NEW."lastCredentialOperationId" IS DISTINCT FROM OLD."lastCredentialOperationId")
    OR (NEW."sessionSecurityVersion">OLD."sessionSecurityVersion" AND (NEW."lastSessionSecurityOperationId" IS NULL OR NEW."lastSessionSecurityOperationId" IS NOT DISTINCT FROM OLD."lastSessionSecurityOperationId"))
    OR (NEW."sessionSecurityVersion"=OLD."sessionSecurityVersion" AND NEW."lastSessionSecurityOperationId" IS DISTINCT FROM OLD."lastSessionSecurityOperationId")
  THEN RAISE EXCEPTION 'account_security_version_attribution_required'; END IF;
  IF NEW."credentialVersion">OLD."credentialVersion" THEN
    UPDATE public."AssistedAccountState"
      SET "requiredChangeCredentialVersion"=NEW."credentialVersion","updatedAt"=clock_timestamp()
      WHERE "userId"=NEW."userId" AND "requiredChangeCredentialVersion" IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public."clear_assisted_required_change_after_password_change_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW."operationKey"='password_change' AND NEW."status"='completed' AND NEW."outcomeCode"='changed' THEN
    UPDATE public."AssistedAccountState" SET "requiredChangeCredentialVersion"=NULL,"updatedAt"=clock_timestamp()
    WHERE "userId"=NEW."userId" AND "requiredChangeCredentialVersion" IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "GlobalSecurityOperation_assisted_required_change_clear"
AFTER UPDATE ON public."GlobalSecurityOperation" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."clear_assisted_required_change_after_password_change_v1"();

CREATE FUNCTION public."acquire_assisted_credential_fence_v1"()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  LOCK TABLE public."HouseholdMember" IN EXCLUSIVE MODE NOWAIT;
END $$;

CREATE FUNCTION public."lock_actor_session_for_assisted_operation_nowait"(scope_user_id TEXT,scope_session_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_session public."Session"%ROWTYPE;
BEGIN
  SELECT * INTO actor_session FROM public."Session"
    WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE NOWAIT;
  IF actor_session."id" IS NULL OR actor_session."expiresAt"<=clock_timestamp()
    OR actor_session."createdAt"<=clock_timestamp()-INTERVAL '10 minutes'
  THEN RAISE EXCEPTION 'assisted_actor_session_invalid' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public."lock_user_sessions_for_assisted_operation_nowait"(scope_user_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public."Session" WHERE "userId"=scope_user_id ORDER BY "id" FOR UPDATE NOWAIT;
END $$;

CREATE FUNCTION public."lock_actor_session_for_browser_write_v1"(scope_user_id TEXT,scope_session_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_session public."Session"%ROWTYPE; activity public."SessionSecurityActivity"%ROWTYPE;
  security_state public."AccountSecurityState"%ROWTYPE; assisted_state public."AssistedAccountState"%ROWTYPE;
BEGIN
  SELECT * INTO actor_session FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE NOWAIT;
  SELECT * INTO activity FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_session_id AND "userId"=scope_user_id FOR UPDATE NOWAIT;
  SELECT * INTO security_state FROM public."AccountSecurityState" WHERE "userId"=scope_user_id FOR SHARE NOWAIT;
  SELECT * INTO assisted_state FROM public."AssistedAccountState" WHERE "userId"=scope_user_id FOR SHARE NOWAIT;
  IF actor_session."id" IS NULL OR actor_session."expiresAt"<=clock_timestamp()
    OR security_state."userId" IS NULL OR activity."sessionId" IS NULL OR activity."state"<>'active'
    OR activity."issuanceSessionSecurityVersion"<>security_state."sessionSecurityVersion"
    OR assisted_state."requiredChangeCredentialVersion" IS NOT NULL
  THEN RAISE EXCEPTION 'browser_write_session_invalid' USING ERRCODE='42501'; END IF;
END $$;

-- Extend the final target-shape constraint without changing any existing key semantics.
ALTER TABLE public."BrowserOperationBinding" DROP CONSTRAINT "BrowserOperationBinding_target_shape_check";
ALTER TABLE public."BrowserOperationBinding" ADD CONSTRAINT "BrowserOperationBinding_target_shape_check" CHECK (
  "persistenceVersion"=1 OR CASE "operationKey"::text
    WHEN 'activity.create' THEN "targetKind"='baby' AND "targetId"="babyId" AND "babyId" IS NOT NULL
    WHEN 'activity.update' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.delete' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.undo_last' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.pause' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.resume' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.stop' THEN "targetKind"='activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'baby.create' THEN "targetKind"='baby' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'baby.deactivate' THEN "targetKind"='baby' AND "targetId"="babyId" AND "babyId" IS NOT NULL
    WHEN 'baby.reactivate' THEN "targetKind"='baby' AND "targetId"="babyId" AND "babyId" IS NOT NULL
    WHEN 'dashboard.warning.dismiss' THEN "targetKind"='warning' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
    WHEN 'invite.create' THEN "targetKind"='invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'invite.revoke' THEN "targetKind"='invite' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'invite.revoke_all' THEN "targetKind"='invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'member.restore' THEN "targetKind"='member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.remove' THEN "targetKind"='member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.role.update' THEN "targetKind"='member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.suspend' THEN "targetKind"='member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.account.create' THEN "targetKind"='household' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'member.password.reset' THEN "targetKind"='member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'notification.preference.save' THEN "targetKind"='preference' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'settings.units.update' THEN "targetKind"='settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'calendar_event.create' THEN "targetKind"='calendar' AND "targetId" IS NULL AND "babyId" IS NOT NULL
    WHEN 'household.accent.update' THEN "targetKind"='settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'api_key.revoke' THEN "targetKind"='api_key' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'planned_schedule.save' THEN "targetKind"='baby' AND "targetId"="babyId" AND "babyId" IS NOT NULL
    WHEN 'feed_post.create' THEN "targetKind"='post' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'feed_post.delete' THEN "targetKind"='post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_post.update' THEN "targetKind"='post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_post.restore' THEN "targetKind"='post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.create' THEN "targetKind" IN ('post','activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.update' THEN "targetKind"='comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.delete' THEN "targetKind"='comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_reaction.set' THEN "targetKind" IN ('post','activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    ELSE false END
);

CREATE FUNCTION public."try_lock_assisted_browser_identity_v1"(scope_household_id TEXT,scope_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE identity_text TEXT:='household-browser-operation:v1:'||scope_household_id||':'||scope_operation_id;
BEGIN
  IF NOT pg_try_advisory_xact_lock((('x'||substr(md5(identity_text),1,16))::bit(64)::bigint))
    OR NOT pg_try_advisory_xact_lock((('x'||substr(md5(identity_text),17,16))::bit(64)::bigint))
  THEN RAISE EXCEPTION 'assisted_browser_identity_busy' USING ERRCODE='55P03'; END IF;
END $$;

CREATE FUNCTION public."write_assisted_account_audit_v1"(
  scope_household_id TEXT,scope_actor_user_id TEXT,scope_actor_member_id TEXT,
  scope_target_member_id TEXT,scope_operation_id TEXT,scope_action TEXT,scope_outcome TEXT,scope_created_at TIMESTAMP(3)
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE audit_id TEXT:='aae_'||encode(gen_random_bytes(16),'hex'); chain_order INTEGER;
  previous_hash TEXT; event_hash TEXT; envelope TEXT; after_json JSONB;
BEGIN
  IF scope_action NOT IN ('member.account.create','member.password.reset') THEN RAISE EXCEPTION 'assisted_audit_action_invalid'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('audit-chain:'||scope_household_id)) THEN
    RAISE EXCEPTION 'assisted_audit_chain_busy' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public."AuditIntegrityCheckpoint" WHERE "scope"='household:'||scope_household_id FOR UPDATE NOWAIT;
  SELECT count(*)::INTEGER+1 INTO chain_order FROM public."AuditEvent" WHERE "householdId"=scope_household_id;
  SELECT "eventHash" INTO previous_hash FROM public."AuditEvent"
    WHERE "householdId"=scope_household_id AND "eventHash" IS NOT NULL ORDER BY "chainOrder" DESC LIMIT 1;
  after_json:=jsonb_build_object('operationId',scope_operation_id,'outcome',scope_outcome);
  envelope:='{"event":{"id":'||to_json(audit_id)::text
    ||',"after":{"outcome":'||to_json(scope_outcome)::text||',"operationId":'||to_json(scope_operation_id)::text||'}'
    ||',"action":'||to_json(scope_action)::text||',"babyId":null,"before":null'
    ||',"entityId":'||to_json(scope_target_member_id)::text
    ||',"createdAt":'||to_json(to_char(scope_created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    ||',"chainOrder":'||chain_order::text||',"entityType":"household_member"'
    ||',"actorUserId":'||to_json(scope_actor_user_id)::text||',"householdId":'||to_json(scope_household_id)::text
    ||',"actorMemberId":'||to_json(scope_actor_member_id)::text||',"correlationId":'||to_json(scope_operation_id)::text
    ||',"schemaVersion":3,"actorUserSnapshot":'||to_json(scope_actor_user_id)::text
    ||',"actorMemberSnapshot":'||to_json(scope_actor_member_id)::text||'},"previousHash":'
    ||COALESCE(to_json(previous_hash)::text,'null')||'}';
  event_hash:=encode(digest(convert_to(envelope,'UTF8'),'sha256'),'hex');
  INSERT INTO public."AuditEvent"("id","householdId","actorUserId","actorMemberId","actorUserSnapshot","actorMemberSnapshot",
    "action","entityType","entityId","schemaVersion","correlationId","chainOrder","previousHash","eventHash","before","after","createdAt")
  VALUES(audit_id,scope_household_id,scope_actor_user_id,scope_actor_member_id,scope_actor_user_id,scope_actor_member_id,
    scope_action,'household_member',scope_target_member_id,3,scope_operation_id,chain_order,previous_hash,event_hash,NULL,after_json,scope_created_at);
  INSERT INTO public."AuditIntegrityCheckpoint"("scope","headHash","eventCount","verifiedAt")
  VALUES('household:'||scope_household_id,event_hash,chain_order,scope_created_at)
  ON CONFLICT ("scope") DO UPDATE SET "headHash"=EXCLUDED."headHash","eventCount"=EXCLUDED."eventCount","verifiedAt"=EXCLUDED."verifiedAt";
  RETURN audit_id;
END $$;

CREATE FUNCTION public."assert_assisted_credential_mutation_success_v1"(scope_household_id TEXT,scope_operation_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public."AssistedCredentialMutation"%ROWTYPE; binding_row public."BrowserOperationBinding"%ROWTYPE;
  operation_row public."BrowserMutationOperation"%ROWTYPE; assisted_state public."AssistedAccountState"%ROWTYPE;
  security_state public."AccountSecurityState"%ROWTYPE; account_row public."Account"%ROWTYPE;
  target_member public."HouseholdMember"%ROWTYPE; audit_count BIGINT;
  -- PL/pgSQL ends an IF condition at the first THEN keyword, so a CASE expression cannot appear
  -- inside one. These expected values are computed first and compared as plain variables below.
  expected_outcome_kind TEXT; expected_outcome_code TEXT; expected_required_version INTEGER;
BEGIN
  SELECT * INTO receipt FROM public."AssistedCredentialMutation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  SELECT * INTO binding_row FROM public."BrowserOperationBinding" WHERE "id"=receipt."browserBindingId";
  SELECT * INTO operation_row FROM public."BrowserMutationOperation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  SELECT * INTO assisted_state FROM public."AssistedAccountState" WHERE "userId"=receipt."targetUserId";
  SELECT * INTO security_state FROM public."AccountSecurityState" WHERE "userId"=receipt."targetUserId";
  SELECT * INTO account_row FROM public."Account" WHERE "id"=receipt."accountId";
  SELECT * INTO target_member FROM public."HouseholdMember" WHERE "id"=receipt."targetMemberId";
  SELECT count(*) INTO audit_count FROM public."AuditEvent"
    WHERE "householdId"=receipt."householdId" AND "actorUserId"=receipt."actorUserId"
      AND "actorMemberId"=receipt."actorMemberId" AND "entityType"='household_member'
      AND "entityId"=receipt."targetMemberId" AND "correlationId"=receipt."operationId"
      AND "action"=CASE receipt."operationKey"::text WHEN 'member.account.create' THEN 'member.account.create' ELSE 'member.password.reset' END
      AND "before" IS NULL
      AND "after"=jsonb_build_object('operationId',receipt."operationId",'outcome',
        CASE receipt."operationKey"::text WHEN 'member.account.create' THEN 'created' ELSE 'reset' END);

  expected_outcome_kind:=CASE receipt."operationKey"::text
    WHEN 'member.account.create' THEN 'member_account' ELSE 'member_password' END;
  expected_outcome_code:=CASE receipt."operationKey"::text
    WHEN 'member.account.create' THEN 'created' ELSE 'reset' END;
  expected_required_version:=CASE WHEN receipt."requireFirstLoginPasswordChange"
    THEN receipt."newCredentialVersion" ELSE NULL END;

  IF receipt."operationId" IS NULL OR binding_row."id" IS NULL OR operation_row."operationId" IS NULL
    OR binding_row."id"<>receipt."browserBindingId" OR binding_row."householdId"<>receipt."householdId"
    OR binding_row."operationId"<>receipt."operationId" OR binding_row."operationKey"<>receipt."operationKey"
    OR binding_row."sessionId"<>receipt."actorSessionId" OR binding_row."actorUserId"<>receipt."actorUserId"
    OR binding_row."actorMemberId"<>receipt."actorMemberId" OR binding_row."state"<>'terminal'
    OR binding_row."openingFingerprint" IS DISTINCT FROM receipt."openingFingerprint"
    OR binding_row."intentFingerprint" IS NOT NULL
    OR binding_row."persistenceVersion"<>2 OR binding_row."protocolVersion"<>'browser_v2'
    OR binding_row."babyId" IS NOT NULL
    OR binding_row."targetSnapshot"->>'householdId' IS DISTINCT FROM receipt."householdId"
    OR binding_row."targetSnapshot"->>'actorMemberId' IS DISTINCT FROM receipt."actorMemberId"
    OR (receipt."operationKey"='member.account.create'::public."BrowserOperationKey"
      AND (binding_row."targetKind" IS DISTINCT FROM 'household' OR binding_row."targetId" IS NOT NULL))
    OR (receipt."operationKey"='member.password.reset'::public."BrowserOperationKey"
      AND (binding_row."targetKind" IS DISTINCT FROM 'member'
        OR binding_row."targetId" IS DISTINCT FROM receipt."targetMemberId"
        OR binding_row."targetSnapshot"->>'targetMemberId' IS DISTINCT FROM receipt."targetMemberId"
        OR binding_row."targetSnapshot"->>'targetUserId' IS DISTINCT FROM receipt."targetUserId"))
    OR operation_row."bindingId"<>receipt."browserBindingId" OR operation_row."operationKey"<>receipt."operationKey"
    OR operation_row."actorUserId"<>receipt."actorUserId" OR operation_row."actorMemberId"<>receipt."actorMemberId"
    OR operation_row."openingFingerprint" IS DISTINCT FROM receipt."openingFingerprint"
    OR operation_row."intentFingerprint" IS DISTINCT FROM receipt."intentFingerprint" OR operation_row."status"<>'completed'
    OR operation_row."persistenceVersion"<>2 OR operation_row."babyId" IS NOT NULL
    OR operation_row."outcomeVersion" IS DISTINCT FROM 1
    OR operation_row."terminalAt" IS NULL OR operation_row."auditCorrelation" IS DISTINCT FROM receipt."operationId"
    OR (receipt."operationKey"='member.account.create'::public."BrowserOperationKey"
      AND (operation_row."targetKind" IS DISTINCT FROM 'household' OR operation_row."targetId" IS NOT NULL))
    OR (receipt."operationKey"='member.password.reset'::public."BrowserOperationKey"
      AND (operation_row."targetKind" IS DISTINCT FROM 'member' OR operation_row."targetId" IS DISTINCT FROM receipt."targetMemberId"))
    OR operation_row."outcomeSnapshot" IS DISTINCT FROM jsonb_build_object('memberId',receipt."targetMemberId")
    OR operation_row."outcomeKind" IS DISTINCT FROM expected_outcome_kind
    OR operation_row."outcomeCode" IS DISTINCT FROM expected_outcome_code
    OR target_member."id" IS NULL OR target_member."householdId"<>receipt."householdId" OR target_member."userId"<>receipt."targetUserId"
    OR security_state."userId" IS NULL OR assisted_state."userId" IS NULL
    OR security_state."credentialVersion"<>receipt."newCredentialVersion"
    OR security_state."sessionSecurityVersion"<>receipt."newSessionSecurityVersion"
    OR security_state."lastCredentialOperationId"<>receipt."operationId"
    OR security_state."lastSessionSecurityOperationId"<>receipt."operationId"
    OR account_row."id" IS NULL OR account_row."userId"<>receipt."targetUserId" OR account_row."providerId"<>'credential'
    OR account_row."password" IS NULL
    OR digest(convert_to(account_row."password",'UTF8'),'sha256')<>receipt."passwordHashDigest"
    OR assisted_state."requiredChangeCredentialVersion" IS DISTINCT FROM expected_required_version
    OR (receipt."operationKey"='member.account.create'::public."BrowserOperationKey" AND
      (assisted_state."assistedCreationHouseholdId" IS DISTINCT FROM receipt."householdId"
        OR assisted_state."assistedCreationMemberId" IS DISTINCT FROM receipt."targetMemberId"
        OR assisted_state."assistedCreationOperationId" IS DISTINCT FROM receipt."operationId"))
    OR audit_count<>1
  THEN RAISE EXCEPTION 'assisted_credential_mutation_success_closure_invalid' USING ERRCODE='23514'; END IF;

  IF receipt."operationKey"='member.password.reset'::public."BrowserOperationKey" AND (
    EXISTS (SELECT 1 FROM public."Session" WHERE "userId"=receipt."targetUserId")
    OR EXISTS (SELECT 1 FROM public."SessionSecurityActivity" WHERE "userId"=receipt."targetUserId" AND "state"='active')
    OR EXISTS (SELECT 1 FROM public."FreshAuthGrant" WHERE "userId"=receipt."targetUserId" AND "state"='issued')
    OR EXISTS (SELECT 1 FROM public."RecoverySession" WHERE "userId"=receipt."targetUserId" AND "state"='restricted')
    OR EXISTS (
      SELECT 1 FROM public."RecoverySession" recovery
      WHERE recovery."userId"=receipt."targetUserId" AND recovery."state"='closed' AND recovery."closedAt"=receipt."createdAt"
        AND NOT EXISTS (
          SELECT 1 FROM public."GlobalSecurityOperation" recovery_operation
          JOIN public."GlobalSecurityOperationBinding" recovery_binding ON recovery_binding."id"=recovery_operation."bindingId"
          JOIN public."GlobalSecurityEvent" recovery_event ON recovery_event."userId"=recovery."userId"
            AND recovery_event."operationId"=recovery."operationId" AND recovery_event."eventType"='operation_outcome'
            AND recovery_event."outcome"='stale_security_version' AND recovery_event."safeProjection"='{}'::jsonb
          WHERE recovery_operation."userId"=recovery."userId" AND recovery_operation."operationId"=recovery."operationId"
            AND recovery_operation."status"='stale' AND recovery_operation."outcomeCode"='stale_security_version'
            AND recovery_binding."state"='terminal' AND recovery_binding."recoverySessionId"=recovery."id"
        )
    )
  ) THEN RAISE EXCEPTION 'assisted_password_reset_partial_closure' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION public."assert_completed_assisted_operation_has_receipt_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW."operationKey" IN ('member.account.create'::public."BrowserOperationKey",'member.password.reset'::public."BrowserOperationKey")
    AND NEW."status"='completed'
  THEN PERFORM public."assert_assisted_credential_mutation_success_v1"(NEW."householdId",NEW."operationId"); END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public."assert_assisted_credential_mutation_success_trigger_v1"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public."assert_assisted_credential_mutation_success_v1"(NEW."householdId",NEW."operationId");
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "AssistedCredentialMutation_success_closure"
AFTER INSERT ON public."AssistedCredentialMutation" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."assert_assisted_credential_mutation_success_trigger_v1"();
CREATE CONSTRAINT TRIGGER "BrowserMutationOperation_assisted_receipt_closure"
AFTER INSERT OR UPDATE ON public."BrowserMutationOperation" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."assert_completed_assisted_operation_has_receipt_v1"();

CREATE FUNCTION public."create_assisted_member_account_v1"(
  scope_actor_user_id TEXT,scope_actor_session_id TEXT,scope_actor_member_id TEXT,scope_household_id TEXT,
  scope_operation_id TEXT,scope_opening_fingerprint TEXT,scope_intent_fingerprint TEXT,scope_display_name TEXT,
  scope_email TEXT,scope_role public."HouseholdRole",scope_replacement_password_hash TEXT,
  scope_replacement_password_hash_digest BYTEA,scope_require_first_change BOOLEAN,scope_attestation_key_version INTEGER,
  scope_attestation_nonce BYTEA,scope_attestation_issued_at TIMESTAMP,scope_attestation_mac BYTEA
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_session public."Session"%ROWTYPE; actor_member public."HouseholdMember"%ROWTYPE;
  actor_activity public."SessionSecurityActivity"%ROWTYPE; actor_security public."AccountSecurityState"%ROWTYPE;
  actor_assisted public."AssistedAccountState"%ROWTYPE; platform_authority public."PlatformAuthority"%ROWTYPE;
  platform_settings public."PlatformSettings"%ROWTYPE; household_row public."Household"%ROWTYPE;
  binding_row public."BrowserOperationBinding"%ROWTYPE; existing_user public."User"%ROWTYPE;
  key_row public."FreshAuthAttestationKey"%ROWTYPE; normalized_email TEXT:=lower(btrim(scope_email));
  display_name TEXT:=btrim(scope_display_name); created_user_id TEXT; created_account_id TEXT; created_member_id TEXT;
  now_time TIMESTAMP(3):=date_trunc('milliseconds',clock_timestamp()); replacement_digest BYTEA;
  new_values_frame BYTEA; new_values_digest BYTEA; attestation_frame BYTEA; expected_mac BYTEA;
BEGIN
  PERFORM public."acquire_assisted_credential_fence_v1"();

  SELECT * INTO platform_authority FROM public."PlatformAuthority" WHERE "id"='platform' FOR SHARE NOWAIT;
  SELECT * INTO platform_settings FROM public."PlatformSettings" WHERE "id"='platform' FOR SHARE NOWAIT;
  SELECT * INTO existing_user FROM public."User" WHERE public."normalize_security_email_v1"("email")=normalized_email;
  PERFORM 1 FROM public."User" WHERE "id" IN (scope_actor_user_id,existing_user."id") ORDER BY "id" FOR KEY SHARE NOWAIT;
  PERFORM 1 FROM public."AccountSecurityState" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "userId" FOR SHARE NOWAIT;
  SELECT * INTO actor_security FROM public."AccountSecurityState" WHERE "userId"=scope_actor_user_id;
  SELECT * INTO actor_assisted FROM public."AssistedAccountState" WHERE "userId"=scope_actor_user_id FOR SHARE NOWAIT;
  PERFORM 1 FROM public."Account" WHERE "userId" IN (scope_actor_user_id,existing_user."id") AND "providerId"='credential' ORDER BY "id" FOR SHARE NOWAIT;
  PERFORM public."lock_actor_session_for_assisted_operation_nowait"(scope_actor_user_id,scope_actor_session_id);
  SELECT * INTO actor_session FROM public."Session" WHERE "id"=scope_actor_session_id;
  PERFORM 1 FROM public."SessionSecurityActivity" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "sessionId" FOR UPDATE NOWAIT;
  SELECT * INTO actor_activity FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_actor_session_id;
  PERFORM 1 FROM public."FreshAuthGrant" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO key_row FROM public."FreshAuthAttestationKey" WHERE "keyVersion"=scope_attestation_key_version FOR SHARE NOWAIT;
  PERFORM 1 FROM public."RecoverySession" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperationBinding" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperation" WHERE "userId" IN (scope_actor_user_id,existing_user."id") ORDER BY "userId","operationId" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."HouseholdMember" WHERE "id"=scope_actor_member_id ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO actor_member FROM public."HouseholdMember" WHERE "id"=scope_actor_member_id;
  SELECT * INTO household_row FROM public."Household" WHERE "id"=scope_household_id FOR KEY SHARE NOWAIT;
  PERFORM public."try_lock_assisted_browser_identity_v1"(scope_household_id,scope_operation_id);
  SELECT * INTO binding_row FROM public."BrowserOperationBinding"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR UPDATE NOWAIT;

  IF platform_authority."id" IS NULL OR platform_settings."id" IS NULL OR household_row."id" IS NULL
    OR household_row."deletedAt" IS NOT NULL OR actor_session."id" IS NULL
    OR actor_member."id" IS NULL OR actor_member."householdId"<>scope_household_id
    OR actor_member."userId"<>actor_session."userId" OR actor_session."userId"<>scope_actor_user_id
    OR actor_member."disabledAt" IS NOT NULL OR actor_member."deletedAt" IS NOT NULL
    OR actor_security."userId" IS NULL OR actor_activity."sessionId" IS NULL OR actor_activity."state"<>'active'
    OR actor_activity."issuanceSessionSecurityVersion"<>actor_security."sessionSecurityVersion"
    OR actor_assisted."requiredChangeCredentialVersion" IS NOT NULL
    OR actor_member."role" NOT IN ('owner','admin')
    OR NOT (actor_member."role"='owner' OR (actor_member."role"='admin' AND scope_role IN ('parent','caretaker','read_only')))
    OR scope_role NOT IN ('admin','parent','caretaker','read_only')
    OR EXISTS (SELECT 1 FROM invitation_protocol."InvitationAccountSetup" setup
      WHERE setup."userId"=scope_actor_user_id AND setup."accountOrigin"='invitation_created' AND setup."setupState"<>'accepted')
  THEN RAISE EXCEPTION 'assisted_actor_not_authorized' USING ERRCODE='42501'; END IF;

  IF binding_row."id" IS NULL OR binding_row."sessionId"<>scope_actor_session_id
    OR binding_row."actorUserId"<>scope_actor_user_id OR binding_row."actorMemberId"<>scope_actor_member_id
    OR binding_row."operationKey"<>'member.account.create'::public."BrowserOperationKey"
    OR binding_row."persistenceVersion"<>2 OR binding_row."protocolVersion"<>'browser_v2'
    OR binding_row."openingFingerprint" IS DISTINCT FROM scope_opening_fingerprint OR binding_row."state"<>'open'
    OR binding_row."expiresAt"<=clock_timestamp() OR binding_row."targetKind" IS DISTINCT FROM 'household'
    OR binding_row."targetId" IS NOT NULL OR binding_row."babyId" IS NOT NULL
    OR binding_row."targetSnapshot"->>'householdId' IS DISTINCT FROM scope_household_id
    OR binding_row."targetSnapshot"->>'actorMemberId' IS DISTINCT FROM scope_actor_member_id
    OR binding_row."targetSnapshot"->>'actorRole' IS DISTINCT FROM actor_member."role"::text
    OR binding_row."targetSnapshot"->>'actorMembershipUpdatedAt' IS DISTINCT FROM
      to_char(actor_member."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR binding_row."targetSnapshot"->>'platformAuthorityUpdatedAt' IS DISTINCT FROM
      to_char(platform_authority."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN RAISE EXCEPTION 'assisted_browser_binding_invalid' USING ERRCODE='23514'; END IF;

  IF normalized_email IS NULL OR length(normalized_email)>254 OR normalized_email!~'^[^@[:space:]]+@[^@[:space:]]+$'
    OR char_length(display_name) NOT BETWEEN 1 AND 191 OR scope_role IS NULL OR scope_require_first_change IS NULL
    OR scope_replacement_password_hash IS NULL OR scope_replacement_password_hash!~'^[0-9a-f]{16,}:[0-9a-f]{32,}$'
    OR scope_replacement_password_hash_digest IS NULL OR octet_length(scope_replacement_password_hash_digest)<>32
    OR scope_attestation_nonce IS NULL OR octet_length(scope_attestation_nonce)<>32
    OR scope_attestation_mac IS NULL OR octet_length(scope_attestation_mac)<>32
    OR scope_attestation_issued_at IS NULL OR scope_attestation_key_version IS NULL
    OR scope_attestation_issued_at<>date_trunc('milliseconds',scope_attestation_issued_at)
    OR scope_attestation_issued_at>clock_timestamp()+INTERVAL '5 seconds'
    OR scope_attestation_issued_at<=clock_timestamp()-INTERVAL '10 minutes'
  THEN RAISE EXCEPTION 'assisted_credential_attestation_invalid' USING ERRCODE='22023'; END IF;
  IF key_row."keyVersion" IS NULL OR key_row."active" IS NOT TRUE
    OR (key_row."rotatedAt" IS NOT NULL AND key_row."rotatedAt"<=clock_timestamp()-INTERVAL '10 minutes')
  THEN RAISE EXCEPTION 'assisted_credential_attestation_key_invalid' USING ERRCODE='42501'; END IF;
  replacement_digest:=digest(convert_to(scope_replacement_password_hash,'UTF8'),'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(replacement_digest,scope_replacement_password_hash_digest)
  THEN RAISE EXCEPTION 'assisted_replacement_digest_invalid' USING ERRCODE='22023'; END IF;
  new_values_frame:=int4send(octet_length(convert_to(normalized_email,'UTF8')))||convert_to(normalized_email,'UTF8')
    ||int4send(octet_length(convert_to(display_name,'UTF8')))||convert_to(display_name,'UTF8')
    ||int4send(octet_length(convert_to(scope_role::text,'UTF8')))||convert_to(scope_role::text,'UTF8')
    ||CASE WHEN scope_require_first_change THEN decode('01','hex') ELSE decode('00','hex') END;
  new_values_digest:=digest(new_values_frame,'sha256');
  attestation_frame:=convert_to('cubby.admin-assisted-credential-mutation.v1','UTF8')
    ||int4send(octet_length(convert_to('member_account_create','UTF8')))||convert_to('member_account_create','UTF8')
    ||int4send(octet_length(convert_to(scope_actor_user_id,'UTF8')))||convert_to(scope_actor_user_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_actor_session_id,'UTF8')))||convert_to(scope_actor_session_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_actor_member_id,'UTF8')))||convert_to(scope_actor_member_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_household_id,'UTF8')))||convert_to(scope_household_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_operation_id,'UTF8')))||convert_to(scope_operation_id,'UTF8')
    ||int4send(octet_length(convert_to(scope_opening_fingerprint,'UTF8')))||convert_to(scope_opening_fingerprint,'UTF8')
    ||int4send(octet_length(convert_to(scope_intent_fingerprint,'UTF8')))||convert_to(scope_intent_fingerprint,'UTF8')
    ||int4send(octet_length(scope_replacement_password_hash_digest))||scope_replacement_password_hash_digest
    ||int4send(octet_length(new_values_digest))||new_values_digest||int8send((-1)::bigint)||int8send((-1)::bigint)
    ||timestamp_send(scope_attestation_issued_at)
    ||int4send(octet_length(scope_attestation_nonce))||scope_attestation_nonce||int4send(scope_attestation_key_version);
  expected_mac:=public.hmac(attestation_frame,key_row."verificationKey",'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(expected_mac,scope_attestation_mac)
    OR EXISTS (SELECT 1 FROM public."AssistedCredentialMutation" WHERE "attestationNonce"=scope_attestation_nonce)
  THEN RAISE EXCEPTION 'assisted_credential_attestation_mac_invalid' USING ERRCODE='42501'; END IF;

  INSERT INTO public."BrowserMutationOperation"("bindingId","householdId","operationId","operationKey","actorUserId","actorMemberId",
    "openingFingerprint","intentFingerprint","persistenceVersion","targetKind","targetId","babyId","status","createdAt","updatedAt")
  VALUES(binding_row."id",scope_household_id,scope_operation_id,'member.account.create',scope_actor_user_id,scope_actor_member_id,
    scope_opening_fingerprint,scope_intent_fingerprint,2,'household',NULL,NULL,'pending',now_time,now_time);
  UPDATE public."BrowserOperationBinding" SET "state"='submitted',"updatedAt"=now_time WHERE "id"=binding_row."id";

  IF existing_user."id" IS NOT NULL THEN
    UPDATE public."BrowserMutationOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeKind"='member_account',
      "outcomeCode"='existing_account_invitation_required',"outcomeSnapshot"=NULL,"terminalAt"=now_time,"updatedAt"=now_time
      WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
    UPDATE public."BrowserOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
    RETURN jsonb_build_object('operationId',scope_operation_id,'status','rejected','outcomeCode','existing_account_invitation_required');
  END IF;

  created_user_id:='usr_'||encode(gen_random_bytes(16),'hex');
  created_account_id:='acc_'||encode(gen_random_bytes(16),'hex');
  created_member_id:='hm_'||encode(gen_random_bytes(16),'hex');
  INSERT INTO public."User"("id","name","email","emailVerified","createdAt","updatedAt")
    VALUES(created_user_id,display_name,normalized_email,false,now_time,now_time);
  INSERT INTO public."Account"("id","accountId","providerId","userId","password","createdAt","updatedAt")
    VALUES(created_account_id,created_user_id,'credential',created_user_id,scope_replacement_password_hash,now_time,now_time);
  INSERT INTO public."AccountSecurityState"("userId","credentialVersion","sessionSecurityVersion","lastCredentialOperationId","lastSessionSecurityOperationId","securityUpdatedAt")
    VALUES(created_user_id,1,1,scope_operation_id,scope_operation_id,now_time);
  INSERT INTO public."HouseholdMember"("id","householdId","userId","role","displayName","joinedAt","createdAt","updatedAt")
    VALUES(created_member_id,scope_household_id,created_user_id,scope_role,display_name,now_time,now_time,now_time);
  INSERT INTO public."AssistedCredentialMutation"("householdId","operationId","operationKey","browserBindingId","actorUserId","actorSessionId",
    "actorMemberId","targetUserId","targetMemberId","accountId","openingFingerprint","intentFingerprint","oldCredentialVersion",
    "newCredentialVersion","oldSessionSecurityVersion","newSessionSecurityVersion","passwordHashDigest","requireFirstLoginPasswordChange",
    "attestationNonce","attestationKeyVersion","attestationIssuedAt","attestationMacDigest","createdAt")
  VALUES(scope_household_id,scope_operation_id,'member.account.create',binding_row."id",scope_actor_user_id,scope_actor_session_id,
    scope_actor_member_id,created_user_id,created_member_id,created_account_id,scope_opening_fingerprint,scope_intent_fingerprint,NULL,
    1,NULL,1,replacement_digest,scope_require_first_change,scope_attestation_nonce,scope_attestation_key_version,
    scope_attestation_issued_at,digest(scope_attestation_mac,'sha256'),now_time);
  INSERT INTO public."AssistedAccountState"("userId","assistedCreationHouseholdId","assistedCreationMemberId","assistedCreationOperationId",
    "requiredChangeCredentialVersion","createdAt","updatedAt")
  VALUES(created_user_id,scope_household_id,created_member_id,scope_operation_id,
    CASE WHEN scope_require_first_change THEN 1 ELSE NULL END,now_time,now_time);
  PERFORM public."write_assisted_account_audit_v1"(scope_household_id,scope_actor_user_id,scope_actor_member_id,
    created_member_id,scope_operation_id,'member.account.create','created',now_time);
  UPDATE public."BrowserMutationOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeKind"='member_account',
    "outcomeCode"='created',"outcomeSnapshot"=jsonb_build_object('memberId',created_member_id),"auditCorrelation"=scope_operation_id,
    "terminalAt"=now_time,"updatedAt"=now_time WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  UPDATE public."BrowserOperationBinding" SET "state"='terminal',"updatedAt"=now_time WHERE "id"=binding_row."id";
  RETURN jsonb_build_object('operationId',scope_operation_id,'status','completed','outcomeCode','created','memberId',created_member_id);
END $$;

CREATE FUNCTION public."get_assisted_account_operation_status_v1"(
  scope_actor_user_id TEXT,scope_actor_session_id TEXT,scope_household_id TEXT,scope_operation_id TEXT
)
RETURNS TABLE("operationId" TEXT,"status" TEXT,"outcomeCode" TEXT,"outcomeKind" TEXT,"targetMemberId" TEXT,"terminalAt" TIMESTAMP(3),"compacted" BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
DECLARE receipt public."AssistedCredentialMutation"%ROWTYPE; binding_row public."BrowserOperationBinding"%ROWTYPE;
  operation_row public."BrowserMutationOperation"%ROWTYPE; tombstone public."BrowserMutationOperationTombstone"%ROWTYPE;
  actor_member public."HouseholdMember"%ROWTYPE; target_member public."HouseholdMember"%ROWTYPE;
  actor_session public."Session"%ROWTYPE; actor_activity public."SessionSecurityActivity"%ROWTYPE;
  actor_security public."AccountSecurityState"%ROWTYPE; actor_assisted public."AssistedAccountState"%ROWTYPE;
  household_row public."Household"%ROWTYPE; platform_authority public."PlatformAuthority"%ROWTYPE;
  operation_key public."BrowserOperationKey"; target_user_id TEXT; target_member_id TEXT;
  actor_member_id TEXT; original_session_id TEXT;
BEGIN
  PERFORM public."acquire_assisted_credential_fence_v1"();
  SELECT * INTO receipt FROM public."AssistedCredentialMutation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  SELECT * INTO binding_row FROM public."BrowserOperationBinding"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  SELECT * INTO operation_row FROM public."BrowserMutationOperation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  SELECT * INTO tombstone FROM public."BrowserMutationOperationTombstone"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id;
  actor_member_id:=COALESCE(receipt."actorMemberId",binding_row."actorMemberId",operation_row."actorMemberId",tombstone."actorMemberId");
  original_session_id:=COALESCE(receipt."actorSessionId",binding_row."sessionId");
  operation_key:=COALESCE(receipt."operationKey",binding_row."operationKey",operation_row."operationKey",tombstone."operationKey");
  target_user_id:=COALESCE(receipt."targetUserId",binding_row."targetSnapshot"->>'targetUserId');
  target_member_id:=COALESCE(receipt."targetMemberId",binding_row."targetSnapshot"->>'targetMemberId',operation_row."targetId");

  SELECT * INTO platform_authority FROM public."PlatformAuthority" WHERE "id"='platform' FOR SHARE NOWAIT;
  PERFORM 1 FROM public."PlatformSettings" WHERE "id"='platform' FOR SHARE NOWAIT;
  PERFORM 1 FROM public."User" WHERE "id" IN (scope_actor_user_id,target_user_id) ORDER BY "id" FOR KEY SHARE NOWAIT;
  PERFORM 1 FROM public."AccountSecurityState" WHERE "userId" IN (scope_actor_user_id,target_user_id) ORDER BY "userId" FOR SHARE NOWAIT;
  PERFORM 1 FROM public."AssistedAccountState" WHERE "userId"=scope_actor_user_id FOR SHARE NOWAIT;
  PERFORM 1 FROM public."Account" WHERE "userId" IN (scope_actor_user_id,target_user_id) AND "providerId"='credential' ORDER BY "id" FOR SHARE NOWAIT;
  -- Historical status needs a current original session, not a recent sign-in.
  -- Create/reset retain their separate ten-minute freshness helper.
  SELECT * INTO actor_session FROM public."Session"
    WHERE "id"=scope_actor_session_id AND "userId"=scope_actor_user_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."SessionSecurityActivity" WHERE "userId"=scope_actor_user_id ORDER BY "sessionId" FOR UPDATE NOWAIT;
  SELECT * INTO actor_activity FROM public."SessionSecurityActivity" WHERE "sessionId"=scope_actor_session_id;
  SELECT * INTO actor_security FROM public."AccountSecurityState" WHERE "userId"=scope_actor_user_id;
  SELECT * INTO actor_assisted FROM public."AssistedAccountState" WHERE "userId"=scope_actor_user_id;
  PERFORM 1 FROM public."FreshAuthGrant" WHERE "userId"=scope_actor_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."RecoverySession" WHERE "userId"=scope_actor_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperationBinding" WHERE "userId"=scope_actor_user_id ORDER BY "id" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."GlobalSecurityOperation" WHERE "userId"=scope_actor_user_id ORDER BY "userId","operationId" FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."HouseholdMember" WHERE "id" IN (actor_member_id,target_member_id) ORDER BY "id" FOR UPDATE NOWAIT;
  SELECT * INTO actor_member FROM public."HouseholdMember" WHERE "id"=actor_member_id;
  SELECT * INTO target_member FROM public."HouseholdMember" WHERE "id"=target_member_id;
  PERFORM 1 FROM public."Household" WHERE "id"=scope_household_id ORDER BY "id" FOR KEY SHARE NOWAIT;
  SELECT * INTO household_row FROM public."Household" WHERE "id"=scope_household_id;
  PERFORM public."try_lock_assisted_browser_identity_v1"(scope_household_id,scope_operation_id);
  SELECT * INTO binding_row FROM public."BrowserOperationBinding"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR SHARE NOWAIT;
  SELECT * INTO operation_row FROM public."BrowserMutationOperation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR SHARE NOWAIT;
  SELECT * INTO tombstone FROM public."BrowserMutationOperationTombstone"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR SHARE NOWAIT;
  SELECT * INTO receipt FROM public."AssistedCredentialMutation"
    WHERE "householdId"=scope_household_id AND "operationId"=scope_operation_id FOR SHARE NOWAIT;

  IF platform_authority."id" IS NULL OR household_row."id" IS NULL OR household_row."deletedAt" IS NOT NULL
    OR actor_session."id" IS NULL OR actor_session."userId"<>scope_actor_user_id
    OR actor_session."expiresAt"<=clock_timestamp()
    OR actor_security."userId" IS NULL OR actor_activity."sessionId" IS NULL OR actor_activity."state"<>'active'
    OR actor_activity."issuanceSessionSecurityVersion"<>actor_security."sessionSecurityVersion"
    OR actor_assisted."requiredChangeCredentialVersion" IS NOT NULL
    OR actor_member."id" IS NULL OR actor_member."userId"<>scope_actor_user_id
    OR actor_member."householdId"<>scope_household_id OR actor_member."disabledAt" IS NOT NULL OR actor_member."deletedAt" IS NOT NULL
    OR actor_member."role" NOT IN ('owner','admin') OR original_session_id IS DISTINCT FROM scope_actor_session_id
    OR operation_key IS NULL OR operation_key NOT IN ('member.account.create'::public."BrowserOperationKey",'member.password.reset'::public."BrowserOperationKey")
    OR COALESCE(receipt."actorUserId",binding_row."actorUserId",operation_row."actorUserId",tombstone."actorUserId")<>scope_actor_user_id
    OR EXISTS (SELECT 1 FROM invitation_protocol."InvitationAccountSetup" setup
      WHERE setup."userId"=scope_actor_user_id AND setup."accountOrigin"='invitation_created' AND setup."setupState"<>'accepted')
  THEN RETURN; END IF;

  IF target_user_id IS NOT NULL OR target_member_id IS NOT NULL THEN
    IF target_member."id" IS NULL OR target_member."householdId"<>scope_household_id OR target_member."userId"<>target_user_id
      OR target_member."deletedAt" IS NOT NULL OR target_member."role"='owner'
      OR target_user_id=scope_actor_user_id OR platform_authority."ownerUserId"=target_user_id
      OR (actor_member."role"='admin' AND target_member."role" NOT IN ('parent','caretaker','read_only'))
      OR (operation_key='member.password.reset'::public."BrowserOperationKey" AND EXISTS (
        SELECT 1 FROM public."HouseholdMember" foreign_member WHERE foreign_member."userId"=target_user_id
          AND foreign_member."householdId"<>scope_household_id AND foreign_member."deletedAt" IS NULL))
    THEN RETURN; END IF;
  END IF;

  IF operation_row."operationId" IS NOT NULL THEN
    RETURN QUERY SELECT scope_operation_id,operation_row."status"::text,operation_row."outcomeCode",operation_row."outcomeKind",
      COALESCE(receipt."targetMemberId",operation_row."outcomeSnapshot"->>'memberId',operation_row."targetId"),operation_row."terminalAt",false;
    RETURN;
  END IF;
  IF tombstone."operationId" IS NOT NULL AND receipt."operationId" IS NOT NULL
    AND tombstone."operationKey"=receipt."operationKey" AND tombstone."actorUserId"=receipt."actorUserId"
    AND tombstone."actorMemberId"=receipt."actorMemberId" AND tombstone."intentFingerprint"=receipt."intentFingerprint"
  THEN
    RETURN QUERY SELECT scope_operation_id,tombstone."terminalStatus"::text,tombstone."terminalCode",
      CASE receipt."operationKey"::text WHEN 'member.account.create' THEN 'member_account' ELSE 'member_password' END,
      receipt."targetMemberId",tombstone."terminalAt",true;
  END IF;
END $$;

CREATE FUNCTION public."sign_out_required_change_session_v1"(scope_user_id TEXT,scope_session_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE session_row public."Session"%ROWTYPE; state_row public."AssistedAccountState"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0));
  SELECT * INTO session_row FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id FOR UPDATE;
  SELECT * INTO state_row FROM public."AssistedAccountState" WHERE "userId"=scope_user_id FOR SHARE;
  IF session_row."id" IS NULL OR session_row."expiresAt"<=clock_timestamp()
    OR state_row."requiredChangeCredentialVersion" IS NULL THEN RETURN false; END IF;
  UPDATE public."SessionSecurityActivity" SET "state"='revoked',"updatedAt"=clock_timestamp()
    WHERE "sessionId"=scope_session_id AND "userId"=scope_user_id AND "state"='active';
  DELETE FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public."compact_household_browser_operation"(
  scope_ref TEXT,operation_id TEXT,compacted_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE full_operation public."BrowserMutationOperation"%ROWTYPE; bound public."BrowserOperationBinding"%ROWTYPE;
BEGIN
  PERFORM public."lock_household_browser_operation_identity"(scope_ref,operation_id);
  SELECT * INTO full_operation FROM public."BrowserMutationOperation"
    WHERE "householdId"=scope_ref AND "operationId"=operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO bound FROM public."BrowserOperationBinding" WHERE "id"=full_operation."bindingId" FOR UPDATE;
  IF full_operation."status" NOT IN ('completed','rejected','stale') OR full_operation."terminalAt" IS NULL
    OR full_operation."terminalAt">compacted_at-INTERVAL '30 days' THEN RETURN false; END IF;
  INSERT INTO public."BrowserMutationOperationTombstone"("householdId","operationId","operationKey","actorUserId","actorMemberId",
    "intentFingerprint","terminalStatus","terminalCode","createdAt","terminalAt","compactedAt","auditCorrelation")
  VALUES(full_operation."householdId",full_operation."operationId",full_operation."operationKey",full_operation."actorUserId",
    full_operation."actorMemberId",full_operation."intentFingerprint",full_operation."status",full_operation."outcomeCode",
    full_operation."createdAt",full_operation."terminalAt",compacted_at,full_operation."auditCorrelation")
  ON CONFLICT ("householdId","operationId") DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public."BrowserMutationOperationTombstone" tombstone
    WHERE tombstone."householdId"=scope_ref AND tombstone."operationId"=operation_id
      AND tombstone."operationKey"=full_operation."operationKey" AND tombstone."actorUserId"=full_operation."actorUserId"
      AND tombstone."actorMemberId"=full_operation."actorMemberId" AND tombstone."intentFingerprint"=full_operation."intentFingerprint"
      AND tombstone."terminalStatus"=full_operation."status" AND tombstone."terminalCode"=full_operation."outcomeCode")
  THEN RAISE EXCEPTION 'browser_operation_compaction_ambiguous' USING ERRCODE='23514'; END IF;
  IF full_operation."operationKey" IN ('member.account.create'::public."BrowserOperationKey",'member.password.reset'::public."BrowserOperationKey")
    AND full_operation."status"='completed' AND NOT EXISTS (
      SELECT 1 FROM public."AssistedCredentialMutation" receipt
      WHERE receipt."householdId"=scope_ref AND receipt."operationId"=operation_id
        AND receipt."operationKey"=full_operation."operationKey" AND receipt."browserBindingId"=bound."id"
        AND receipt."actorUserId"=full_operation."actorUserId" AND receipt."actorMemberId"=full_operation."actorMemberId"
        AND receipt."actorSessionId"=bound."sessionId" AND receipt."openingFingerprint"=full_operation."openingFingerprint"
        AND receipt."intentFingerprint"=full_operation."intentFingerprint")
  THEN
    -- A committed completed operation had a receipt by its deferred converse.
    -- The immutable receipt can disappear only through target-User FK cascade.
    -- Keep rejecting mismatched live receipts; permit that sole deletion path
    -- only with the immutable terminal shape and no surviving target member.
    IF EXISTS (SELECT 1 FROM public."AssistedCredentialMutation" receipt
      WHERE receipt."householdId"=scope_ref AND receipt."operationId"=operation_id)
    THEN RAISE EXCEPTION 'assisted_browser_operation_compaction_receipt_mismatch' USING ERRCODE='23514'; END IF;
    IF full_operation."persistenceVersion"<>2 OR bound."id" IS NULL
      OR bound."protocolVersion"<>'browser_v2' OR bound."state"<>'terminal'
      OR bound."intentFingerprint" IS NOT NULL
      OR full_operation."outcomeSnapshot"->>'memberId' IS NULL
      OR full_operation."outcomeSnapshot" IS DISTINCT FROM jsonb_build_object('memberId',full_operation."outcomeSnapshot"->>'memberId')
      OR EXISTS (SELECT 1 FROM public."HouseholdMember" surviving_target
        WHERE surviving_target."id"=full_operation."outcomeSnapshot"->>'memberId')
      OR (full_operation."operationKey"='member.password.reset'::public."BrowserOperationKey" AND (
        bound."targetSnapshot"->>'targetUserId' IS NULL
        OR EXISTS (SELECT 1 FROM public."User" surviving_target
          WHERE surviving_target."id"=bound."targetSnapshot"->>'targetUserId')))
    THEN RAISE EXCEPTION 'assisted_compaction_target_deletion_unproven' USING ERRCODE='23514'; END IF;
  END IF;
  DELETE FROM public."BrowserMutationOperation" WHERE "householdId"=scope_ref AND "operationId"=operation_id;
  DELETE FROM public."BrowserOperationBinding" WHERE "id"=full_operation."bindingId";
  RETURN true;
END $$;

REVOKE ALL ON TABLE public."AssistedAccountState",public."AssistedCredentialMutation" FROM PUBLIC;
REVOKE ALL ON FUNCTION public."prevent_assisted_credential_mutation_change_v1"(),public."prevent_assisted_retention_truncate_v1"(),
  public."enforce_assisted_account_state_transition_v1"(),public."enforce_account_security_version_transition"(),
  public."clear_assisted_required_change_after_password_change_v1"(),
  public."try_lock_assisted_browser_identity_v1"(TEXT,TEXT),
  public."write_assisted_account_audit_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMP),
  public."assert_assisted_credential_mutation_success_v1"(TEXT,TEXT),
  public."assert_completed_assisted_operation_has_receipt_v1"(),public."assert_assisted_credential_mutation_success_trigger_v1"()
FROM PUBLIC,cubby_runtime,cubby_auth;

REVOKE ALL ON FUNCTION "acquire_assisted_credential_fence_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "lock_actor_session_for_assisted_operation_nowait"(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "lock_user_sessions_for_assisted_operation_nowait"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "lock_actor_session_for_browser_write_v1"(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "create_assisted_member_account_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,public."HouseholdRole",TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION "reset_assisted_member_password_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION "get_assisted_account_operation_status_v1"(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "sign_out_required_change_session_v1"(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."compact_household_browser_operation"(TEXT,TEXT,TIMESTAMP) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE ALL ON TABLE public."AssistedCredentialMutation" FROM cubby_runtime;
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE public."AssistedAccountState" FROM cubby_runtime;
    GRANT SELECT ON TABLE public."AssistedAccountState" TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "acquire_assisted_credential_fence_v1"() TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "lock_actor_session_for_assisted_operation_nowait"(TEXT,TEXT) TO cubby_runtime;
    -- The service takes this identity lock directly in its pre-identity hook, so unlike the
    -- trigger/definer-internal helpers below it must be executable by the restricted runtime role.
    GRANT EXECUTE ON FUNCTION "try_lock_assisted_browser_identity_v1"(TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "lock_user_sessions_for_assisted_operation_nowait"(TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "lock_actor_session_for_browser_write_v1"(TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "create_assisted_member_account_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,public."HouseholdRole",TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "reset_assisted_member_password_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "get_assisted_account_operation_status_v1"(TEXT,TEXT,TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "sign_out_required_change_session_v1"(TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION public."compact_household_browser_operation"(TEXT,TEXT,TIMESTAMP) TO cubby_runtime;
  END IF;
END $$;

-- Existing legitimate runtime User writes are intentionally preserved. Account credential writes,
-- Session writes, receipt writes and attestation-key reads remain available only through their
-- previously reviewed owners or the exact definer procedures above.
COMMIT;
