-- The household-owned attachment resource (DEC-PROD-141-147); feed photos are its first type
-- (DEC-PROD-422). Metadata lives here and verified bytes in the private attachment store. Every
-- reference carries the household, so no attachment can link across households.
CREATE TYPE "AttachmentType" AS ENUM ('feed_photo');

CREATE TYPE "AttachmentState" AS ENUM ('staging', 'available', 'unavailable', 'deleted', 'purged');

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "state" "AttachmentState" NOT NULL DEFAULT 'staging',
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "postId" TEXT,
    "position" INTEGER,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "unavailableAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedByMemberId" TEXT,
    "purgeAfter" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id"),
    -- A random, meaningless storage name and a verified size and digest; nothing from the upload.
    CONSTRAINT "Attachment_storage_check" CHECK (
      "storageKey" ~ '^[a-f0-9]{32}$' AND "sha256" ~ '^[a-f0-9]{64}$' AND "byteSize" > 0 AND "width" > 0 AND "height" > 0
    ),
    -- Feed photos are re-saved as JPEG, at most ten to a post.
    CONSTRAINT "Attachment_type_check" CHECK (
      "type" <> 'feed_photo' OR ("mimeType" = 'image/jpeg' AND ("position" IS NULL OR "position" BETWEEN 0 AND 9))
    ),
    -- A staged upload is claimed by nothing and was never activated; anything past staging was, and
    -- belongs to a post with its place in it.
    CONSTRAINT "Attachment_lifecycle_check" CHECK (
      CASE "state"
        WHEN 'staging' THEN "postId" IS NULL AND "position" IS NULL AND "activatedAt" IS NULL
          AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
        WHEN 'available' THEN "activatedAt" IS NOT NULL AND "postId" IS NOT NULL AND "position" IS NOT NULL
          AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
        WHEN 'unavailable' THEN "unavailableAt" IS NOT NULL AND "purgedAt" IS NULL
        WHEN 'deleted' THEN "deletedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "purgedAt" IS NULL
        WHEN 'purged' THEN "purgedAt" IS NOT NULL
      END
    )
);

CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

CREATE INDEX "Attachment_state_purgeAfter_idx" ON "Attachment"("state", "purgeAfter");

CREATE INDEX "Attachment_state_createdAt_idx" ON "Attachment"("state", "createdAt");

CREATE UNIQUE INDEX "Attachment_householdId_id_key" ON "Attachment"("householdId", "id");

CREATE UNIQUE INDEX "Attachment_householdId_postId_position_key" ON "Attachment"("householdId", "postId", "position");

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_householdId_postId_fkey" FOREIGN KEY ("householdId", "postId") REFERENCES "FeedPost"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_householdId_createdByMemberId_fkey" FOREIGN KEY ("householdId", "createdByMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rows are never deleted: a purged attachment stays as a tombstone so a restore cannot revive it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE "Attachment" TO cubby_runtime';
  END IF;
END $$;
