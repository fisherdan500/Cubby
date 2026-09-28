BEGIN;

ALTER TABLE public."Session"
  ADD COLUMN "credentialProofPurpose" TEXT,
  ADD COLUMN "credentialProofHashDigest" BYTEA,
  ADD COLUMN "credentialProofIssuedAt" TIMESTAMP(3),
  ADD COLUMN "credentialProofNonce" BYTEA,
  ADD COLUMN "credentialProofKeyVersion" INTEGER,
  ADD COLUMN "credentialProofMac" BYTEA,
  ADD CONSTRAINT "Session_credential_proof_all_or_none_check" CHECK (
    ("credentialProofPurpose" IS NULL AND "credentialProofHashDigest" IS NULL AND "credentialProofIssuedAt" IS NULL
      AND "credentialProofNonce" IS NULL AND "credentialProofKeyVersion" IS NULL AND "credentialProofMac" IS NULL)
    OR
    ("credentialProofPurpose" IS NOT NULL AND "credentialProofHashDigest" IS NOT NULL AND "credentialProofIssuedAt" IS NOT NULL
      AND "credentialProofNonce" IS NOT NULL AND "credentialProofKeyVersion" IS NOT NULL AND "credentialProofMac" IS NOT NULL)
  ),
  ADD CONSTRAINT "Session_credential_proof_shape_check" CHECK (
    "credentialProofPurpose" IS NULL OR (
      "credentialProofPurpose" = 'credential_sign_in'
      AND octet_length("credentialProofHashDigest") = 32
      AND octet_length("credentialProofNonce") = 32
      AND octet_length("credentialProofMac") = 32
      AND "credentialProofKeyVersion" > 0
    )
  );

CREATE UNIQUE INDEX "Session_credentialProofNonce_key" ON public."Session"("credentialProofNonce");

CREATE FUNCTION "credential_proof_constant_time_equal_v1"(left_value BYTEA, right_value BYTEA)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
DECLARE
  difference INTEGER := 0;
  position INTEGER;
BEGIN
  IF octet_length(left_value) IS DISTINCT FROM 32 OR octet_length(right_value) IS DISTINCT FROM 32 THEN RETURN false; END IF;
  FOR position IN 0..31 LOOP
    difference := difference | (get_byte(left_value, position) # get_byte(right_value, position));
  END LOOP;
  RETURN difference = 0;
END $$;

CREATE FUNCTION "guard_session_credential_proof_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  credential_hash TEXT;
  credential_count BIGINT;
  credential_digest BYTEA;
  token_digest BYTEA;
  key_row public."FreshAuthAttestationKey"%ROWTYPE;
  payload BYTEA;
  expected_mac BYTEA;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0));
  IF session_user <> 'cubby_auth' THEN RETURN NEW; END IF;

  IF NEW."credentialProofPurpose" IS DISTINCT FROM 'credential_sign_in'
    OR NEW."credentialProofHashDigest" IS NULL OR octet_length(NEW."credentialProofHashDigest") IS DISTINCT FROM 32
    OR NEW."credentialProofIssuedAt" IS NULL
    OR NEW."credentialProofNonce" IS NULL OR octet_length(NEW."credentialProofNonce") IS DISTINCT FROM 32
    OR NEW."credentialProofKeyVersion" IS NULL
    OR NEW."credentialProofMac" IS NULL OR octet_length(NEW."credentialProofMac") IS DISTINCT FROM 32
  THEN
    RAISE EXCEPTION 'session_credential_proof_required';
  END IF;

  IF NEW."credentialProofIssuedAt" > clock_timestamp() + INTERVAL '5 seconds'
    OR NEW."credentialProofIssuedAt" <= clock_timestamp() - INTERVAL '10 minutes'
  THEN
    RAISE EXCEPTION 'session_credential_proof_expired';
  END IF;

  SELECT count(*), min(account_row."password")
    INTO credential_count, credential_hash
  FROM public."Account" account_row
  WHERE account_row."userId" = NEW."userId" AND account_row."providerId" = 'credential';
  IF credential_count IS DISTINCT FROM 1 OR credential_hash IS NULL THEN
    RAISE EXCEPTION 'session_credential_proof_credential_invalid';
  END IF;

  credential_digest := digest(convert_to(credential_hash,'UTF8'),'sha256');
  token_digest := digest(convert_to(NEW."token",'UTF8'),'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(credential_digest, NEW."credentialProofHashDigest") THEN
    RAISE EXCEPTION 'session_credential_proof_credential_mismatch';
  END IF;

  SELECT * INTO key_row
  FROM public."FreshAuthAttestationKey"
  WHERE "keyVersion" = NEW."credentialProofKeyVersion"
    AND "active" = true
    AND ("rotatedAt" IS NULL OR "rotatedAt" > clock_timestamp() - INTERVAL '10 minutes');
  IF key_row."keyVersion" IS NULL THEN RAISE EXCEPTION 'session_credential_proof_key_invalid'; END IF;

  IF EXISTS (
    SELECT 1 FROM public."Session" existing
    WHERE existing."credentialProofNonce" = NEW."credentialProofNonce"
  ) THEN
    RAISE EXCEPTION 'session_credential_proof_nonce_reused';
  END IF;

  payload := convert_to('cubby.password-session-proof.v1','UTF8')
    || int4send(octet_length(convert_to(NEW."credentialProofPurpose",'UTF8')))||convert_to(NEW."credentialProofPurpose",'UTF8')
    || int4send(octet_length(convert_to(NEW."userId",'UTF8')))||convert_to(NEW."userId",'UTF8')
    || int4send(octet_length(token_digest))||token_digest
    || int4send(octet_length(NEW."credentialProofHashDigest"))||NEW."credentialProofHashDigest"
    || timestamp_send(NEW."credentialProofIssuedAt")
    || int4send(octet_length(NEW."credentialProofNonce"))||NEW."credentialProofNonce"
    || int4send(NEW."credentialProofKeyVersion");
  expected_mac := public.hmac(payload, key_row."verificationKey", 'sha256');
  IF NOT public."credential_proof_constant_time_equal_v1"(expected_mac, NEW."credentialProofMac") THEN
    RAISE EXCEPTION 'session_credential_proof_mac_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Session_00_credential_proof_guard" BEFORE INSERT ON public."Session"
FOR EACH ROW EXECUTE FUNCTION "guard_session_credential_proof_v1"();

CREATE FUNCTION "prevent_session_credential_proof_update_v1"()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW."credentialProofPurpose",NEW."credentialProofHashDigest",NEW."credentialProofIssuedAt",NEW."credentialProofNonce",NEW."credentialProofKeyVersion",NEW."credentialProofMac")
    IS DISTINCT FROM ROW(OLD."credentialProofPurpose",OLD."credentialProofHashDigest",OLD."credentialProofIssuedAt",OLD."credentialProofNonce",OLD."credentialProofKeyVersion",OLD."credentialProofMac")
  THEN
    RAISE EXCEPTION 'session_credential_proof_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Session_credential_proof_immutable" BEFORE UPDATE ON public."Session"
FOR EACH ROW EXECUTE FUNCTION "prevent_session_credential_proof_update_v1"();

CREATE OR REPLACE FUNCTION "write_global_security_session_sign_in_event"()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Runtime-created email-change successor sessions and trusted fixtures use a
  -- different session_user and retain their existing initialization paths.
  IF session_user <> 'cubby_auth' THEN RETURN NEW; END IF;
  PERFORM public."initialize_global_session_security_activity"(NEW."userId",NEW."id");
  INSERT INTO public."GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt")
    VALUES ('gse_signin_' || encode(gen_random_bytes(16),'hex'),NEW."userId",'credential','sign_in_succeeded',NULL,NULL,'{}',clock_timestamp());
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION "credential_proof_constant_time_equal_v1"(BYTEA,BYTEA) FROM PUBLIC,cubby_runtime,cubby_auth;
REVOKE ALL ON FUNCTION "guard_session_credential_proof_v1"() FROM PUBLIC,cubby_runtime,cubby_auth;
REVOKE ALL ON FUNCTION "prevent_session_credential_proof_update_v1"() FROM PUBLIC,cubby_runtime,cubby_auth;
REVOKE ALL ON FUNCTION "write_global_security_session_sign_in_event"() FROM PUBLIC,cubby_runtime,cubby_auth;

COMMIT;
