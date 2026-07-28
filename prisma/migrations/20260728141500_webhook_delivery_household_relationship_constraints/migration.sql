BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "WebhookDelivery" AS delivery
    LEFT JOIN "WebhookEndpoint" AS endpoint ON endpoint."id" = delivery."endpointId"
    WHERE endpoint."id" IS NULL
      OR delivery."householdId" <> endpoint."householdId"
  ) THEN
    RAISE EXCEPTION 'tenant_relationship_preflight_failed:webhook_delivery_endpoint';
  END IF;
END
$$;

ALTER TABLE "WebhookEndpoint"
  ADD CONSTRAINT "WebhookEndpoint_householdId_id_key" UNIQUE ("householdId", "id");

ALTER TABLE "WebhookDelivery"
  ADD CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey"
  FOREIGN KEY ("householdId", "endpointId")
  REFERENCES "WebhookEndpoint" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WebhookDelivery"
  VALIDATE CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey";

COMMIT;
