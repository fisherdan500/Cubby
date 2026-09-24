-- First-account setup with the one-time setup code.
--
-- A fresh install has no way to create its first account: general sign-up is closed (the auth route
-- answers only sign-in) and claim_platform_setup needs an account that is already signed in. This
-- adds the one sanctioned path, create_platform_owner_account: on an install with no platform owner
-- and no accounts at all, the holder of the setup code printed to the container log creates the
-- first credential and becomes the verified platform owner in the same transaction. A wrong, expired
-- or missing code, or any account already existing, leaves nothing behind.
--
-- It takes the global-security transition lock that invitation credential setup takes, then the
-- platform lock that binding takes, in that order, so it serializes against both and cannot deadlock
-- with either. It receives only the password's hash, never the password.
BEGIN;

CREATE OR REPLACE FUNCTION "create_platform_owner_account"(
  scope_code TEXT,
  scope_name TEXT,
  scope_email TEXT,
  scope_password_hash TEXT
)
RETURNS TABLE("id" TEXT, "ownerUserId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
#variable_conflict use_column
DECLARE code_row public."PlatformSetupCode"%ROWTYPE; display_name TEXT; normalized_email TEXT; created_user_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  PERFORM pg_advisory_xact_lock(1807633529);
  PERFORM 1 FROM public."PlatformAuthority" WHERE "PlatformAuthority"."id" = 'platform' FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'platform_owner_already_bound'; END IF;
  -- Only the very first account: an install that already has one finishes setup by signing in.
  IF EXISTS (SELECT 1 FROM public."User") THEN RAISE EXCEPTION 'platform_setup_install_not_empty'; END IF;

  SELECT * INTO code_row FROM public."PlatformSetupCode" WHERE "PlatformSetupCode"."id" = 'platform' FOR UPDATE;
  -- One outcome for a missing, expired or wrong code, so a caller learns nothing about which it was.
  IF scope_code IS NULL
    OR code_row."id" IS NULL
    OR code_row."expiresAt" <= clock_timestamp()
    OR code_row."codeDigest" IS DISTINCT FROM encode(public.digest(convert_to(scope_code, 'UTF8'), 'sha256'), 'hex')
  THEN
    RAISE EXCEPTION 'platform_setup_code_invalid';
  END IF;

  display_name := left(btrim(scope_name), 120);
  normalized_email := lower(btrim(scope_email));
  IF nullif(display_name, '') IS NULL
    OR normalized_email IS NULL
    OR length(normalized_email) > 254
    OR normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
    OR scope_password_hash IS NULL
    OR scope_password_hash !~ '^[0-9a-f]{16,}:[0-9a-f]{32,}$'
  THEN
    RAISE EXCEPTION 'platform_setup_account_invalid';
  END IF;

  created_user_id := 'usr_' || encode(public.gen_random_bytes(16), 'hex');
  INSERT INTO public."User"("id","name","email","emailVerified","createdAt","updatedAt") VALUES(created_user_id, display_name, normalized_email, true, clock_timestamp(), clock_timestamp());
  INSERT INTO public."Account"("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES('acc_' || encode(public.gen_random_bytes(16), 'hex'), created_user_id, 'credential', created_user_id, scope_password_hash, clock_timestamp(), clock_timestamp());
  INSERT INTO public."AccountSecurityState"("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES(created_user_id, 1,1, clock_timestamp());

  INSERT INTO public."PlatformAuthority" ("id", "ownerUserId", "createdAt", "updatedAt")
  VALUES ('platform', created_user_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO public."PlatformSettings" ("id", "householdCreationMode", "allowPublicRegistration", "revision", "createdAt", "updatedAt")
  VALUES ('platform', 'closed', false, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  DELETE FROM public."PlatformSetupCode";
  RETURN QUERY SELECT 'platform'::TEXT, created_user_id;
END $$;

REVOKE ALL ON FUNCTION "create_platform_owner_account"(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "create_platform_owner_account"(TEXT,TEXT,TEXT,TEXT) TO cubby_runtime;
  END IF;
END $$;

COMMIT;
