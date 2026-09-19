-- Platform-owner bootstrap repair.
--
-- 20260824140000_global_security_foundation guarded "User"."emailVerified" with
-- guard_user_email_change(): any change made where current_user = session_user raises
-- user_email_direct_mutation_forbidden. The host-local platform-owner commands (verify-bootstrap and
-- attest-successor) flipped that flag with a plain UPDATE, so from that migration on they always
-- failed. Nothing else marks an account verified, and bind, onboarding household creation and
-- invitation acceptance all require a verified account, so a fresh install could not finish setup.
--
-- This migration adds two fail-closed SECURITY DEFINER functions, following the same pattern as the
-- email-change and session-lock functions, and a single-row table for a one-time setup code:
--
--   platform_host_verify_user_email  - the verified-flag write behind verify-bootstrap and
--       attest-successor. It re-checks every precondition those commands check, under the same
--       platform lock, so granting it to the runtime role does not widen what may be verified.
--   claim_platform_setup             - consumes the one-time setup code printed to the container log
--       at startup while no platform owner exists, and makes the signed-in account the verified
--       platform owner with the closed default policy that binding creates.
--
-- The setup code is never stored: only its SHA-256 digest. No application role may read the table;
-- only the migration connection writes it (scripts/provision-platform-setup-code.mjs) and only
-- claim_platform_setup reads it.
BEGIN;

CREATE TABLE "PlatformSetupCode" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "codeDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformSetupCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformSetupCode_singleton_check" CHECK ("id" = 'platform'),
    CONSTRAINT "PlatformSetupCode_digest_shape_check" CHECK ("codeDigest" ~ '^[0-9a-f]{64}$')
);

REVOKE ALL ON TABLE "PlatformSetupCode" FROM PUBLIC;

CREATE OR REPLACE FUNCTION "platform_host_verify_user_email"(
  scope_user_id TEXT,
  scope_confirm_email TEXT,
  scope_current_owner_user_id TEXT
)
RETURNS TABLE("id" TEXT, "emailVerified" BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
#variable_conflict use_column
DECLARE authority_row public."PlatformAuthority"%ROWTYPE; user_row public."User"%ROWTYPE;
BEGIN
  IF scope_user_id IS NULL OR scope_confirm_email IS NULL THEN
    RAISE EXCEPTION 'platform_owner_user_not_found';
  END IF;
  PERFORM pg_advisory_xact_lock(1807633529);
  SELECT * INTO authority_row FROM public."PlatformAuthority" WHERE "PlatformAuthority"."id" = 'platform' FOR UPDATE;

  IF scope_current_owner_user_id IS NULL THEN
    -- Bootstrap: only before any owner exists, and only for the install's sole account.
    IF authority_row."id" IS NOT NULL THEN RAISE EXCEPTION 'platform_owner_already_bound'; END IF;
    IF (SELECT count(*) FROM public."User") <> 1 THEN
      RAISE EXCEPTION 'platform_owner_bootstrap_user_count_mismatch';
    END IF;
  ELSE
    -- Successor attestation: only while the named account is the bound owner.
    IF authority_row."id" IS NULL THEN RAISE EXCEPTION 'platform_owner_not_bound'; END IF;
    IF authority_row."ownerUserId" IS DISTINCT FROM scope_current_owner_user_id THEN
      RAISE EXCEPTION 'platform_owner_current_confirmation_mismatch';
    END IF;
    IF scope_user_id = scope_current_owner_user_id THEN
      RAISE EXCEPTION 'platform_owner_successor_must_differ';
    END IF;
  END IF;

  SELECT * INTO user_row FROM public."User" WHERE "User"."id" = scope_user_id FOR UPDATE;
  IF user_row."id" IS NULL THEN RAISE EXCEPTION 'platform_owner_user_not_found'; END IF;
  IF user_row."email" IS DISTINCT FROM scope_confirm_email THEN
    RAISE EXCEPTION 'platform_owner_email_confirmation_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."Account" account_row
    WHERE account_row."userId" = user_row."id"
      AND account_row."providerId" = 'credential'
      AND account_row."password" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'platform_owner_credential_missing';
  END IF;
  IF user_row."emailVerified" THEN RAISE EXCEPTION 'platform_owner_email_already_verified'; END IF;

  UPDATE public."User" SET "emailVerified" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "User"."id" = user_row."id";
  RETURN QUERY SELECT user_row."id", true;
END $$;

REVOKE ALL ON FUNCTION "platform_host_verify_user_email"(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "claim_platform_setup"(scope_user_id TEXT, scope_code TEXT)
RETURNS TABLE("id" TEXT, "ownerUserId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
#variable_conflict use_column
DECLARE code_row public."PlatformSetupCode"%ROWTYPE; user_row public."User"%ROWTYPE;
BEGIN
  IF scope_user_id IS NULL OR scope_code IS NULL THEN
    RAISE EXCEPTION 'platform_setup_code_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1807633529);
  PERFORM 1 FROM public."PlatformAuthority" WHERE "PlatformAuthority"."id" = 'platform' FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'platform_owner_already_bound'; END IF;

  SELECT * INTO code_row FROM public."PlatformSetupCode" WHERE "PlatformSetupCode"."id" = 'platform' FOR UPDATE;
  -- One outcome for a missing, expired or wrong code, so a caller learns nothing about which it was.
  IF code_row."id" IS NULL
    OR code_row."expiresAt" <= clock_timestamp()
    OR code_row."codeDigest" IS DISTINCT FROM encode(public.digest(convert_to(scope_code, 'UTF8'), 'sha256'), 'hex')
  THEN
    RAISE EXCEPTION 'platform_setup_code_invalid';
  END IF;

  SELECT * INTO user_row FROM public."User" WHERE "User"."id" = scope_user_id FOR UPDATE;
  IF user_row."id" IS NULL OR NOT EXISTS (
    SELECT 1 FROM public."Account" account_row
    WHERE account_row."userId" = user_row."id"
      AND account_row."providerId" = 'credential'
      AND account_row."password" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'platform_setup_account_ineligible';
  END IF;

  IF NOT user_row."emailVerified" THEN
    UPDATE public."User" SET "emailVerified" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "User"."id" = user_row."id";
  END IF;
  INSERT INTO public."PlatformAuthority" ("id", "ownerUserId", "createdAt", "updatedAt")
  VALUES ('platform', user_row."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO public."PlatformSettings" ("id", "householdCreationMode", "allowPublicRegistration", "revision", "createdAt", "updatedAt")
  VALUES ('platform', 'closed', false, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  DELETE FROM public."PlatformSetupCode";
  RETURN QUERY SELECT 'platform'::TEXT, user_row."id";
END $$;

REVOKE ALL ON FUNCTION "claim_platform_setup"(TEXT,TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE ALL ON TABLE "PlatformSetupCode" FROM cubby_runtime;
    GRANT EXECUTE ON FUNCTION "platform_host_verify_user_email"(TEXT,TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "claim_platform_setup"(TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

COMMIT;
