-- Disposable protocol probe: proves submit_invitation_acceptance_v2 no longer requires offline
-- recovery codes, the typed household name, or the admin acknowledgement, and that a user stranded
-- in 'recovery_generated' can now reach 'accepted'. Synthetic data only; no household data.
\set ON_ERROR_STOP on
BEGIN;

-- Minimal synthetic fixtures.
INSERT INTO public."User" ("id","name","email","emailVerified","createdAt","updatedAt")
VALUES ('u_probe_codeless','Probe Codeless','codeless@probe.invalid',true,now(),now()),
       ('u_probe_midrehearsal','Probe Mid','mid@probe.invalid',true,now(),now());

INSERT INTO invitation_protocol."InvitationAccountSetup" ("userId","originLineageDigest","accountOrigin","setupState","recoverySetVersion")
VALUES ('u_probe_codeless',decode(repeat('aa',32),'hex'),'invitation_created','credential_created',NULL),
       ('u_probe_midrehearsal',decode(repeat('bb',32),'hex'),'invitation_created','recovery_generated',1);

-- The retired guards, expressed exactly as the OLD function enforced them.
-- If any of these would now block acceptance, the probe fails loudly.
DO $$
DECLARE remaining INTEGER; s TEXT;
BEGIN
  -- 1. codeless user has no RecoveryCodeSet at all
  IF EXISTS (SELECT 1 FROM public."RecoveryCodeSet" WHERE "userId"='u_probe_codeless') THEN
    RAISE EXCEPTION 'probe_unexpected_recovery_set';
  END IF;
  SELECT count(*) INTO remaining FROM public."RecoveryCode" WHERE "userId"='u_probe_codeless' AND "state"='active';
  IF remaining = 9 THEN RAISE EXCEPTION 'probe_unexpected_nine_codes'; END IF;

  -- 2. the deployed function body must no longer reference the retired guards
  SELECT prosrc INTO s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='invitation_protocol' AND p.proname='submit_invitation_acceptance_v2';
  IF s LIKE '%remainingActiveCount<>9%' THEN RAISE EXCEPTION 'probe_nine_code_guard_still_present'; END IF;
  IF s LIKE '%I UNDERSTAND ADMIN ACCESS%' THEN RAISE EXCEPTION 'probe_admin_ack_still_present'; END IF;
  IF s LIKE '%normalize(typed_household_name%' THEN RAISE EXCEPTION 'probe_household_name_still_present'; END IF;
  IF s NOT LIKE '%recovery_generated%' THEN RAISE EXCEPTION 'probe_widening_missing'; END IF;

  -- 3. preserved invariants must still be present
  IF s NOT LIKE '%invitation_operation_conflict%' THEN RAISE EXCEPTION 'probe_cas_lost'; END IF;
  IF s NOT LIKE '%already_member_same_role%' THEN RAISE EXCEPTION 'probe_outcome_matrix_lost'; END IF;
  IF s NOT LIKE '%TERMINAL_FULL%' THEN RAISE EXCEPTION 'probe_replay_lost'; END IF;
END $$;

-- 4. The terminal write must now match BOTH pre-acceptance states, including recovery_generated.
UPDATE invitation_protocol."InvitationAccountSetup" SET "setupState"='accepted'
 WHERE "userId" IN ('u_probe_codeless','u_probe_midrehearsal')
   AND "setupState" IN ('credential_created','credential_existing','recovery_generated','rehearsed');

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM invitation_protocol."InvitationAccountSetup"
   WHERE "userId" IN ('u_probe_codeless','u_probe_midrehearsal') AND "setupState"='accepted';
  IF n <> 2 THEN RAISE EXCEPTION 'probe_terminal_write_missed:%', n; END IF;
END $$;

-- 5. DEC-PROD-428: no database object may REQUIRE a recovery code set for any user.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype='c' AND pg_get_constraintdef(oid) ILIKE '%RecoveryCodeSet%';
  IF n > 0 THEN RAISE EXCEPTION 'probe_recovery_set_required_by_constraint:%', n; END IF;
END $$;

SELECT 'SIMPLIFIED_SIGNUP_PROTOCOL_PROBE_PASS' AS result;
ROLLBACK;
