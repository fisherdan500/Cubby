BEGIN;

-- The runtime role never receives table reads for private security history.
-- This function reauthorizes the captured ordinary session immediately before
-- returning the minimal rows needed for the service's safe projection.
CREATE OR REPLACE FUNCTION "read_global_security_history"(
  scope_user_id TEXT,
  scope_session_id TEXT,
  scope_credential_version INTEGER,
  scope_session_security_version INTEGER,
  scope_snapshot_max_sequence BIGINT,
  scope_last_sequence BIGINT,
  scope_limit INTEGER,
  scope_oldest_first BOOLEAN
)
RETURNS TABLE(
  "sequence" BIGINT,
  "eventId" TEXT,
  "eventClass" TEXT,
  "outcome" TEXT,
  "occurredAt" TIMESTAMP(3),
  "operationKey" TEXT,
  "windowStartedAt" TIMESTAMP(3),
  "failureCount" INTEGER,
  "quietUntil" TIMESTAMP(3),
  "snapshotMaxSequence" BIGINT,
  "exportedAt" TIMESTAMP(3)
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  authorization_row RECORD;
  state_row public."AccountSecurityState"%ROWTYPE;
  snapshot_max_sequence BIGINT;
BEGIN
  IF scope_limit < 1 OR scope_limit > 100001 THEN
    RAISE EXCEPTION 'global_security_history_limit_invalid';
  END IF;
  IF scope_snapshot_max_sequence IS NOT NULL AND scope_snapshot_max_sequence < 1 THEN
    RAISE EXCEPTION 'global_security_history_cursor_invalid';
  END IF;
  IF scope_last_sequence IS NOT NULL AND (
    scope_snapshot_max_sequence IS NULL OR scope_last_sequence < 1 OR scope_last_sequence > scope_snapshot_max_sequence
  ) THEN
    RAISE EXCEPTION 'global_security_history_cursor_invalid';
  END IF;

  -- This is deliberately the last authorization operation before projection.
  SELECT * INTO authorization_row
  FROM public."authorize_global_session_security"(scope_user_id, scope_session_id, NULL);
  SELECT * INTO state_row FROM public."AccountSecurityState"
    WHERE "userId"=scope_user_id FOR UPDATE;
  IF authorization_row."authorized" IS DISTINCT FROM TRUE
    OR state_row."userId" IS NULL
    OR state_row."credentialVersion" IS DISTINCT FROM scope_credential_version
    OR state_row."sessionSecurityVersion" IS DISTINCT FROM scope_session_security_version THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF scope_snapshot_max_sequence IS NULL THEN
    SELECT MAX(event_row."sequence") INTO snapshot_max_sequence
    FROM public."GlobalSecurityEvent" event_row
    WHERE event_row."userId"=scope_user_id;
  ELSE
    snapshot_max_sequence:=scope_snapshot_max_sequence;
  END IF;

  RETURN QUERY
  WITH history_rows AS (
    SELECT
    event_row."sequence",
    event_row."id",
    event_row."eventType",
    event_row."outcome",
    event_row."createdAt",
    operation_row."operationKey"::TEXT,
    incident_row."windowStartedAt",
    incident_row."failureCount",
    incident_row."quietUntil",
    snapshot_max_sequence
    FROM public."GlobalSecurityEvent" event_row
    LEFT JOIN public."GlobalSecurityOperation" operation_row
    ON operation_row."userId"=event_row."userId" AND operation_row."operationId"=event_row."operationId"
    LEFT JOIN public."GlobalSecurityIncident" incident_row
    ON incident_row."id"=event_row."incidentId" AND incident_row."userId"=scope_user_id
    WHERE event_row."userId"=scope_user_id
    AND event_row."sequence"<=snapshot_max_sequence
    AND (scope_last_sequence IS NULL OR event_row."sequence"<scope_last_sequence)
    ORDER BY
    CASE WHEN scope_oldest_first THEN event_row."sequence" END ASC,
    CASE WHEN NOT scope_oldest_first THEN event_row."sequence" END DESC
    LIMIT scope_limit
  )
  SELECT * FROM (
    SELECT history_rows.*, timezone('UTC', clock_timestamp()) FROM history_rows
    UNION ALL
    SELECT NULL::BIGINT,NULL::TEXT,NULL::TEXT,NULL::TEXT,NULL::TIMESTAMP(3),NULL::TEXT,NULL::TIMESTAMP(3),NULL::INTEGER,NULL::TIMESTAMP(3),snapshot_max_sequence,timezone('UTC', clock_timestamp())
    WHERE NOT EXISTS (SELECT 1 FROM history_rows)
  ) projected_rows
  ORDER BY
    CASE WHEN scope_oldest_first THEN projected_rows."sequence" END ASC NULLS LAST,
    CASE WHEN NOT scope_oldest_first THEN projected_rows."sequence" END DESC NULLS LAST;
END $$;

REVOKE ALL ON TABLE "GlobalSecurityEvent","GlobalSecurityIncident","GlobalSecurityThrottleKey" FROM cubby_runtime;
REVOKE ALL ON FUNCTION "read_global_security_history"(TEXT,TEXT,INTEGER,INTEGER,BIGINT,BIGINT,INTEGER,BOOLEAN) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    GRANT EXECUTE ON FUNCTION "read_global_security_history"(TEXT,TEXT,INTEGER,INTEGER,BIGINT,BIGINT,INTEGER,BOOLEAN) TO cubby_runtime;
  END IF;
END $$;

COMMIT;
