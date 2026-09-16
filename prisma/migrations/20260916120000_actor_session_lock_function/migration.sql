-- Browser and account operations serialize against the caller's session row with SELECT ... FOR UPDATE.
-- 20260824140000_global_security_foundation revoked UPDATE on "Session" from cubby_runtime, and PostgreSQL
-- requires UPDATE privilege to take a FOR UPDATE row lock, so every operation issued by the runtime role
-- failed with 42501 permission denied for table Session. That silently broke activity, timer, calendar,
-- appearance, integration and invitation mutations from that migration onwards.
--
-- The privilege boundary is unchanged: the runtime role still cannot INSERT, UPDATE or DELETE "Session".
-- It gains EXECUTE on these fail-closed SECURITY DEFINER functions, which take the same row locks and
-- return the same columns the callers already validate (identity, expiry and sign-in age).
BEGIN;

CREATE OR REPLACE FUNCTION "lock_actor_session_for_operation"(scope_user_id TEXT, scope_session_id TEXT)
RETURNS TABLE("id" TEXT, "userId" TEXT, "createdAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF scope_user_id IS NULL OR scope_session_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT session_row."id", session_row."userId", session_row."createdAt", session_row."expiresAt"
    FROM public."Session" session_row
    WHERE session_row."id" = scope_session_id AND session_row."userId" = scope_user_id
    FOR UPDATE;
END $$;

REVOKE ALL ON FUNCTION "lock_actor_session_for_operation"(TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "lock_user_sessions_for_operation"(scope_user_id TEXT)
RETURNS TABLE("id" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF scope_user_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT session_row."id"
    FROM public."Session" session_row
    WHERE session_row."userId" = scope_user_id
    ORDER BY session_row."id"
    FOR UPDATE;
END $$;

REVOKE ALL ON FUNCTION "lock_user_sessions_for_operation"(TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "lock_actor_session_for_operation"(TEXT,TEXT) TO cubby_runtime;
    GRANT EXECUTE ON FUNCTION "lock_user_sessions_for_operation"(TEXT) TO cubby_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_invitation_runtime') THEN
    GRANT EXECUTE ON FUNCTION "lock_actor_session_for_operation"(TEXT,TEXT) TO cubby_invitation_runtime;
    GRANT EXECUTE ON FUNCTION "lock_user_sessions_for_operation"(TEXT) TO cubby_invitation_runtime;
  END IF;
END $$;

COMMIT;
