-- Add the baby_photo attachment type. PostgreSQL cannot use a new enum value in the
-- same transaction that adds it, so this migration contains the ALTER TYPE alone and
-- opens no transaction. The structural change that references 'baby_photo' lands in
-- the following migration.
--
-- The type remains disabled in application policy (enabledTypes.baby_photo = false)
-- until storage, delivery, recovery, and backup have all passed their gates.
ALTER TYPE "AttachmentType" ADD VALUE IF NOT EXISTS 'baby_photo';
