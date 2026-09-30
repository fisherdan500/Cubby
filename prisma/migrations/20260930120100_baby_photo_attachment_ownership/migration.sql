-- Give an attachment optional baby ownership, so a baby profile picture can exist
-- without a feed post. Additive only: the column is nullable with no default, so no
-- existing row is rewritten, and every existing attachment stays post-owned.
--
-- The foreign key is composite on ("householdId", "babyId") referencing
-- Baby("householdId", "id") so a baby photo can never point at a baby in another
-- household. This matches the tenant-safe shape used by ActivityLog.
--
-- The pre-existing @@unique([householdId, postId, position]) does not constrain rows
-- whose "postId" is NULL, so it cannot express "one current picture per baby". The
-- partial unique index below does. It is scoped to state 'available' because that is
-- the state the delivery path serves, and because a replaced picture stays in its
-- recovery window in state 'deleted' and must not block its replacement.
--
-- The CHECKs keep the two ownership shapes disjoint without forbidding staging. A
-- staged attachment has no parent at all - staging creates the row and the claim step
-- sets the parent - so "babyId" must be allowed to be NULL on a staged baby photo.
-- What must never happen is a baby photo owned by a post, any other type owned by a
-- baby, or a baby photo reaching the served state with no baby.
BEGIN;

ALTER TABLE "Attachment" ADD COLUMN "babyId" TEXT;

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Attachment_householdId_babyId_idx" ON "Attachment"("householdId", "babyId");

CREATE UNIQUE INDEX "Attachment_one_available_baby_photo"
  ON "Attachment"("householdId", "babyId")
  WHERE "type" = 'baby_photo' AND "state" = 'available';

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_baby_photo_parent"
  CHECK (("type" = 'baby_photo' AND "postId" IS NULL) OR ("type" <> 'baby_photo' AND "babyId" IS NULL));

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_available_baby_photo_has_baby"
  CHECK (NOT ("type" = 'baby_photo' AND "state" = 'available' AND "babyId" IS NULL));

-- The lifecycle check from 20260928120000 hard-codes that an AVAILABLE attachment has a post and a
-- position. A baby photo has neither, so it could never leave staging: every attempt fails with
-- "violates check constraint Attachment_lifecycle_check". No source gate reveals this, because none
-- of them parse migration SQL - only a real deploy does.
--
-- The replacement widens the available branch BY OWNERSHIP rather than relaxing it for everyone:
-- a post-owned type still requires its post and position, and a baby photo requires its baby and
-- forbids both. Every other branch is carried over byte-for-byte. Each state stays enumerated,
-- because a CASE with no matching branch yields NULL and a CHECK treats NULL as satisfied - a
-- dropped branch would silently stop enforcing that state.
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_lifecycle_check";

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_lifecycle_check"
  CHECK (CASE "state"
      WHEN 'staging' THEN "postId" IS NULL AND "position" IS NULL AND "babyId" IS NULL AND "activatedAt" IS NULL
        AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
      WHEN 'available' THEN "activatedAt" IS NOT NULL
        AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
        AND CASE WHEN "type" = 'baby_photo'
          THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL
          ELSE "postId" IS NOT NULL AND "position" IS NOT NULL
        END
      WHEN 'unavailable' THEN "unavailableAt" IS NOT NULL AND "purgedAt" IS NULL
      WHEN 'deleted' THEN "deletedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "purgedAt" IS NULL
      WHEN 'purged' THEN "purgedAt" IS NOT NULL
    END);

COMMIT;
