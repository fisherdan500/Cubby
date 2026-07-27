ALTER TYPE "InviteStatus" ADD VALUE IF NOT EXISTS 'conflicted';

UPDATE "Invite"
SET "email" = LOWER(BTRIM("email"))
WHERE "email" <> LOWER(BTRIM("email"));

CREATE INDEX IF NOT EXISTS "Invite_householdId_normalizedEmail_pending_idx"
ON "Invite" ("householdId", LOWER(BTRIM("email")))
WHERE "status" = 'pending';
