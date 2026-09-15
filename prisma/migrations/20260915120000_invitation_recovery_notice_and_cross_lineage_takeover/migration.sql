BEGIN;

-- DEC-PROD-412: the invitation review snapshot additionally discloses whether generating recovery
-- codes will invalidate a prior set, so the client can show an accurate regeneration notice. This is
-- additive metadata outside the integrity-protected digest, matching remainingActiveCount.
--
-- DEC-PROD-413: an account whose InvitationAccountSetup already belongs to a different invitation
-- lineage may now bind to a new invitation only when the prior invitation is no longer active
-- (not pending, or past its expiry). When it is still active, bind remains denied exactly as before.
-- The InvitationAccountSetup_origin_guard trigger is relaxed to allow originLineageId and
-- originLineageDigest to change together (a takeover), while userId/createdAt/accountOrigin remain
-- fully immutable and the null-to-non-null no-rebind rule is unchanged.

SET ROLE invitation_protocol_owner_NOLOGIN;

CREATE OR REPLACE FUNCTION invitation_protocol."InvitationAccountSetup_origin_guard"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
BEGIN
  IF NEW."userId"<>OLD."userId" OR NEW."createdAt"<>OLD."createdAt" OR NEW."accountOrigin"<>OLD."accountOrigin" THEN RAISE EXCEPTION 'invitation_account_origin_immutable'; END IF;
  IF OLD."originLineageId" IS NULL AND NEW."originLineageId" IS NOT NULL THEN RAISE EXCEPTION 'invitation_account_origin_no_rebind'; END IF;
  IF NEW."originLineageId" IS NOT NULL AND (NEW."originLineageId" IS DISTINCT FROM OLD."originLineageId") <> (NEW."originLineageDigest" IS DISTINCT FROM OLD."originLineageDigest") THEN RAISE EXCEPTION 'invitation_account_origin_takeover_inconsistent'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invitation_protocol.bind_post_signin_invitation_claim_v2(session_id TEXT, claim_identity_id UUID, request_attestation invitation_protocol.invitation_request_attestation) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol AS $$
DECLARE identity_row invitation_protocol."InvitationOperationIdentity"%ROWTYPE; claim_row invitation_protocol."InvitationPresentationClaim"%ROWTYPE; lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; invite_row public."Invite"%ROWTYPE; session_row public."Session"%ROWTYPE; user_row public."User"%ROWTYPE; setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE; prior_lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; prior_invite_row public."Invite"%ROWTYPE;
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
  -- DEC-PROD-413: a setup row anchored to a different lineage may take over onto this one only when
  -- the prior lineage's own invitation is no longer pending and unexpired; otherwise bind stays denied.
  IF setup_row."originLineageId" IS DISTINCT FROM lineage_row."id" THEN
    SELECT * INTO prior_lineage_row FROM invitation_protocol."InvitationLineage" WHERE "id"=setup_row."originLineageId" FOR UPDATE;
    IF prior_lineage_row."id" IS NOT NULL THEN SELECT * INTO prior_invite_row FROM public."Invite" WHERE "id"=prior_lineage_row."sourceInviteId" FOR UPDATE; END IF;
    IF prior_lineage_row."id" IS NOT NULL AND prior_invite_row."id" IS NOT NULL AND prior_invite_row."status"='pending' AND prior_invite_row."expiresAt">clock_timestamp() THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;
    UPDATE invitation_protocol."InvitationAccountSetup" SET "originLineageId"=lineage_row."id","originLineageDigest"=public.digest(convert_to(lineage_row."id",'UTF8'),'sha256') WHERE "userId"=user_row."id";
    SELECT * INTO setup_row FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=user_row."id" FOR UPDATE;
  END IF;
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
  RETURN snapshot||jsonb_build_object('no_store',true,'reviewVersion',1,'reviewSnapshotDigest',digest_text,'disclosureCopyVersion','invitation-review-copy-v2','lowercase_hex64',digest_text ~ '^[0-9a-f]{64}$','remainingActiveCount',(SELECT count(*) FROM public."RecoveryCode" WHERE "userId"=user_row."id" AND "setVersion"=setup_row."recoverySetVersion" AND "state"='active'),'hasPriorRecoveryCodes',setup_row."recoverySetVersion" IS NOT NULL);
END $$;

RESET ROLE;

COMMIT;
