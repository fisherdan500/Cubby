-- Browser-operation R3 is forward-only. Existing rows remain browser_v1 and are
-- never rewritten, retargeted, or executed by browser_v2 submit.
BEGIN;

ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'baby.deactivate';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'baby.reactivate';
CREATE TYPE "BrowserOperationProtocolVersion" AS ENUM ('browser_v1', 'browser_v2');
ALTER TABLE "BrowserOperationBinding"
  ADD COLUMN "protocolVersion" "BrowserOperationProtocolVersion" NOT NULL DEFAULT 'browser_v1',
  ADD COLUMN "targetSnapshot" JSONB;

COMMIT;
