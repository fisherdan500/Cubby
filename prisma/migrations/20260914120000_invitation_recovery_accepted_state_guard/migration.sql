BEGIN;

-- An invitation setup that is already accepted must never re-enter recovery enrollment or rehearsal, so an accepted
-- member cannot move their own setup state out of accepted. Bodies are otherwise identical to 20260904120000.

SET ROLE invitation_protocol_owner_NOLOGIN;

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_recovery_rehearsal_v2(operation_id UUID, selected_recovery_code_id TEXT, exact_save_acknowledgement TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; state_row public."AccountSecurityState"%ROWTYPE; set_row public."RecoveryCodeSet"%ROWTYPE; code_row public."RecoveryCode"%ROWTYPE; challenge_row invitation_protocol."InvitationRecoveryRehearsalChallenge"%ROWTYPE;
BEGIN
  IF operation_id IS NULL THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_protocol_v2(COALESCE((request_attestation).subject_user_id,''),operation_id);
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(request_attestation).subject_user_id FOR UPDATE; SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=setup_row."originLineageId" FOR UPDATE;
  IF operation_id IS NULL OR lineage_row."id" IS NULL OR exact_save_acknowledgement<>'I SAVED MY RECOVERY CODES' OR octet_length(opening_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  IF setup_row."setupState"='accepted' THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
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

CREATE OR REPLACE FUNCTION invitation_protocol.reserve_invitation_recovery_enrollment_v2(operation_id UUID, opening_fingerprint BYTEA, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; bridge_row invitation_protocol."InvitationRecoveryEnrollmentBridge"%ROWTYPE;
BEGIN
  PERFORM invitation_protocol.lock_global_security_transition_v1();
  PERFORM invitation_protocol.lock_invitation_operation_v2(operation_id);
  SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=(request_attestation).subject_user_id FOR UPDATE;
  SELECT * INTO lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=setup_row."originLineageId" FOR UPDATE;
  IF operation_id IS NULL OR lineage_row."id" IS NULL OR octet_length(opening_fingerprint)<>32 THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  IF setup_row."setupState"='accepted' THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
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
  IF setup_row."setupState"='accepted' THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
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
  UPDATE invitation_protocol."InvitationAccountSetup" SET "recoverySetVersion"=set_version,"setupState"='recovery_generated' WHERE "userId"=(issuance_attestation).subject_user_id AND "setupState"<>'accepted'; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;
  PERFORM invitation_protocol.execute_invitation_domain_transition_v2(identity_row,'recovery_enrollment'); PERFORM invitation_protocol.write_invitation_terminal_result_v2(identity_row,intent_fingerprint,'recovery_codes_generated',jsonb_build_object('recoverySetVersion',set_version)); PERFORM invitation_protocol.write_invitation_audit_v2(identity_row."householdId",identity_row."id",'recovery.enroll',jsonb_build_object('outcome','generated'),ROW('owner')::invitation_protocol.invitation_owner_private_call_attestation);
  RETURN invitation_protocol.invitation_safe_receipt(operation_id,'generated','recovery_codes_generated')||jsonb_build_object('displayOnce',true);
END $$;

RESET ROLE;

COMMIT;
