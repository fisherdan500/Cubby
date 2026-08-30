BEGIN;

CREATE OR REPLACE FUNCTION "read_global_security_operator_aggregate"(scope_from DATE, scope_to DATE)
RETURNS TABLE("layer" TEXT, "state" TEXT, "coarseTimeBucket" DATE, "incidentCount" BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF scope_from >= scope_to OR scope_to > scope_from + 31 THEN
    RAISE EXCEPTION 'security_operator_aggregate_range_invalid';
  END IF;

  RETURN QUERY
  SELECT
    incident_row."layer"::TEXT,
    incident_row."state"::TEXT,
    ((incident_row."windowStartedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::DATE,
    COUNT(*)::BIGINT
  FROM public."GlobalSecurityIncident" incident_row
  WHERE incident_row."windowStartedAt" >= scope_from::TIMESTAMP
    AND incident_row."windowStartedAt" < scope_to::TIMESTAMP
  GROUP BY
    incident_row."layer",
    incident_row."state",
    ((incident_row."windowStartedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::DATE
  ORDER BY 3 ASC, 1 ASC, 2 ASC;
END $$;

REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_runtime') THEN
    REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM cubby_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_auth') THEN
    REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM cubby_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_email_delivery') THEN
    REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM cubby_email_delivery;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_security_operator') THEN
    GRANT USAGE ON SCHEMA public TO cubby_security_operator;
    GRANT EXECUTE ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) TO cubby_security_operator;
  END IF;
END $$;

COMMIT;
