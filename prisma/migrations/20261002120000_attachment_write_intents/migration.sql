-- New writes only. Never adopt or scavenge historical unowned files.
CREATE TABLE "AttachmentWriteIntent" (
  "storageKey" TEXT PRIMARY KEY,
  "householdId" TEXT REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "purpose" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "cleanedAt" TIMESTAMP(3),
  CONSTRAINT "AttachmentWriteIntent_shape" CHECK (
    "storageKey" ~ '^[a-f0-9]{32}$' AND "sha256" ~ '^[a-f0-9]{64}$'
    AND "purpose" IN ('photo_upload', 'restore_photo')
    AND "state" IN ('pending', 'transferred', 'cleaned')
    AND "byteSize" > 0 AND "byteSize" <= 26214400
    AND (("state" = 'cleaned') = ("cleanedAt" IS NOT NULL))
  )
);
CREATE INDEX "AttachmentWriteIntent_state_nextAttemptAt_idx" ON "AttachmentWriteIntent"("state", "nextAttemptAt");
REVOKE ALL ON "AttachmentWriteIntent" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "AttachmentWriteIntent" TO cubby_runtime;
