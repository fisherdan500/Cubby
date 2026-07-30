-- Preserve existing capabilities as explicitly unattributed while requiring
-- every capability created after this migration to name a same-household
-- membership episode. Capability ownership is write-once: legacy rows cannot
-- be adopted and episode-owned rows cannot be transferred.
BEGIN;

ALTER TABLE "ApiKey" ADD COLUMN "delegatedByMemberId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "legacyUnattributed" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "ApiKey" ALTER COLUMN "legacyUnattributed" SET DEFAULT FALSE;

ALTER TABLE "WebhookEndpoint" ADD COLUMN "delegatedByMemberId" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "legacyUnattributed" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "WebhookEndpoint" ALTER COLUMN "legacyUnattributed" SET DEFAULT FALSE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ApiKey" AS capability
    LEFT JOIN "HouseholdMember" AS member ON member."id" = capability."delegatedByMemberId"
    WHERE (capability."legacyUnattributed" AND capability."delegatedByMemberId" IS NOT NULL)
       OR (NOT capability."legacyUnattributed" AND capability."delegatedByMemberId" IS NULL)
       OR (capability."delegatedByMemberId" IS NOT NULL
           AND (member."id" IS NULL OR capability."householdId" <> member."householdId"))
  ) THEN
    RAISE EXCEPTION 'capability_membership_ownership_preflight_failed:api_key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "WebhookEndpoint" AS capability
    LEFT JOIN "HouseholdMember" AS member ON member."id" = capability."delegatedByMemberId"
    WHERE (capability."legacyUnattributed" AND capability."delegatedByMemberId" IS NOT NULL)
       OR (NOT capability."legacyUnattributed" AND capability."delegatedByMemberId" IS NULL)
       OR (capability."delegatedByMemberId" IS NOT NULL
           AND (member."id" IS NULL OR capability."householdId" <> member."householdId"))
  ) THEN
    RAISE EXCEPTION 'capability_membership_ownership_preflight_failed:webhook_endpoint';
  END IF;
END
$$;

ALTER TABLE "ApiKey"
  ADD CONSTRAINT "ApiKey_legacy_or_delegated_check"
  CHECK (("legacyUnattributed" AND "delegatedByMemberId" IS NULL) OR (NOT "legacyUnattributed" AND "delegatedByMemberId" IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT "ApiKey_householdId_delegatedByMemberId_fkey"
  FOREIGN KEY ("householdId", "delegatedByMemberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "ApiKey" VALIDATE CONSTRAINT "ApiKey_legacy_or_delegated_check";
ALTER TABLE "ApiKey" VALIDATE CONSTRAINT "ApiKey_householdId_delegatedByMemberId_fkey";
CREATE INDEX "ApiKey_delegatedByMemberId_idx" ON "ApiKey"("delegatedByMemberId");

ALTER TABLE "WebhookEndpoint"
  ADD CONSTRAINT "WebhookEndpoint_legacy_or_delegated_check"
  CHECK (("legacyUnattributed" AND "delegatedByMemberId" IS NULL) OR (NOT "legacyUnattributed" AND "delegatedByMemberId" IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT "WebhookEndpoint_householdId_delegatedByMemberId_fkey"
  FOREIGN KEY ("householdId", "delegatedByMemberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "WebhookEndpoint" VALIDATE CONSTRAINT "WebhookEndpoint_legacy_or_delegated_check";
ALTER TABLE "WebhookEndpoint" VALIDATE CONSTRAINT "WebhookEndpoint_householdId_delegatedByMemberId_fkey";
CREATE INDEX "WebhookEndpoint_delegatedByMemberId_idx" ON "WebhookEndpoint"("delegatedByMemberId");

CREATE FUNCTION "prevent_capability_ownership_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."householdId" IS DISTINCT FROM NEW."householdId"
     OR OLD."delegatedByMemberId" IS DISTINCT FROM NEW."delegatedByMemberId"
     OR OLD."legacyUnattributed" IS DISTINCT FROM NEW."legacyUnattributed" THEN
    RAISE EXCEPTION 'capability_ownership_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ApiKey_capability_ownership_immutable"
BEFORE UPDATE ON "ApiKey"
FOR EACH ROW EXECUTE FUNCTION "prevent_capability_ownership_mutation"();

CREATE TRIGGER "WebhookEndpoint_capability_ownership_immutable"
BEFORE UPDATE ON "WebhookEndpoint"
FOR EACH ROW EXECUTE FUNCTION "prevent_capability_ownership_mutation"();

COMMIT;
