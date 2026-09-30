-- Give an attachment optional membership ownership, so a person's profile picture can exist
-- without a feed post and without a baby. Additive only: the column is nullable with no default,
-- so no existing row is rewritten and every existing attachment stays owned exactly as it was.
--
-- Ownership is the MEMBERSHIP, not the user account. A person in two households therefore has one
-- picture per household. That is deliberate: Attachment is household-scoped throughout, and every
-- guarantee in this table - the composite keys, the partial indexes, the delivery filter - rests on
-- that. A user-owned picture would make a file uploaded in one household visible in another.
--
-- The foreign key is composite on ("householdId", "memberId") referencing
-- HouseholdMember("householdId", "id") so a profile picture can never point at a member of another
-- household. This matches the tenant-safe shape used by ActivityLog and by baby ownership.
--
-- ON DELETE RESTRICT, unlike baby ownership's CASCADE: HouseholdMember is also the uploader
-- (createdByMemberId) and is already Restrict there. Cascading here would let removing a person
-- silently delete a stored file and orphan its bytes in object storage. The service layer refuses
-- with a clear reason instead.
--
-- The pre-existing @@unique([householdId, postId, position]) does not constrain rows whose "postId"
-- is NULL, so it cannot express "one current picture per member". The partial unique index below
-- does. It is scoped to state 'available' because that is the state the delivery path serves, and
-- because a replaced picture stays in its recovery window in state 'deleted' and must not block its
-- replacement.
--
-- The CHECKs keep the three ownership shapes disjoint without forbidding staging. A staged
-- attachment has no parent at all - staging creates the row and the claim step sets the parent - so
-- "memberId" must be allowed to be NULL on a staged user photo. What must never happen is a user
-- photo owned by a post or a baby, any other type owned by a member, or a user photo reaching the
-- served state with no member.
BEGIN;

ALTER TABLE "Attachment" ADD COLUMN "memberId" TEXT;

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_householdId_memberId_fkey"
  FOREIGN KEY ("householdId", "memberId")
  REFERENCES "HouseholdMember" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Attachment_householdId_memberId_idx" ON "Attachment"("householdId", "memberId");

CREATE UNIQUE INDEX "Attachment_one_available_user_photo"
  ON "Attachment"("householdId", "memberId")
  WHERE "type" = 'user_photo' AND "state" = 'available';

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_user_photo_parent"
  CHECK (("type" = 'user_photo' AND "postId" IS NULL AND "babyId" IS NULL) OR ("type" <> 'user_photo' AND "memberId" IS NULL));

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_available_user_photo_has_member"
  CHECK (NOT ("type" = 'user_photo' AND "state" = 'available' AND "memberId" IS NULL));

-- The lifecycle check from 20260930120100 enumerates what an AVAILABLE attachment must have, by
-- ownership. A user photo has neither a post nor a baby, so without a branch of its own it could
-- never leave staging: every attempt would fail with "violates check constraint
-- Attachment_lifecycle_check". No source gate reveals this, because none of them parse migration
-- SQL - only a real deploy does. The baby_photo slice hit exactly this trap.
--
-- The replacement adds a user_photo branch and carries every other branch over byte-for-byte: a
-- post-owned type still requires its post and position, a baby photo still requires its baby, and
-- each state stays enumerated, because a CASE with no matching branch yields NULL and a CHECK
-- treats NULL as satisfied - a dropped branch would silently stop enforcing that state.
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_lifecycle_check";

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_lifecycle_check"
  CHECK (CASE "state"
      WHEN 'staging' THEN "postId" IS NULL AND "position" IS NULL AND "babyId" IS NULL AND "memberId" IS NULL AND "activatedAt" IS NULL
        AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
      WHEN 'available' THEN "activatedAt" IS NOT NULL
        AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL
        AND CASE WHEN "type" = 'baby_photo'
          THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL
          WHEN "type" = 'user_photo'
          THEN "memberId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL
          ELSE "postId" IS NOT NULL AND "position" IS NOT NULL
        END
      WHEN 'unavailable' THEN "unavailableAt" IS NOT NULL AND "purgedAt" IS NULL
      WHEN 'deleted' THEN "deletedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "purgedAt" IS NULL
      WHEN 'purged' THEN "purgedAt" IS NOT NULL
    END);

COMMIT;
