ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'api_key.revoke';
ALTER TYPE "BrowserOperationTargetKind" ADD VALUE IF NOT EXISTS 'api_key';
