CREATE TYPE "PlatformRegistrationMode" AS ENUM ('closed', 'invitation_only', 'open');

CREATE TABLE "PlatformAuthority" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAuthority_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformAuthority_singleton_id_check" CHECK ("id" = 'platform')
);

CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "householdCreationMode" "PlatformRegistrationMode" NOT NULL DEFAULT 'closed',
    "allowPublicRegistration" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformSettings_singleton_id_check" CHECK ("id" = 'platform')
);

CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAuthority_ownerUserId_key" ON "PlatformAuthority"("ownerUserId");
CREATE INDEX "PlatformAuditEvent_actorUserId_idx" ON "PlatformAuditEvent"("actorUserId");
CREATE INDEX "PlatformAuditEvent_createdAt_idx" ON "PlatformAuditEvent"("createdAt");

ALTER TABLE "PlatformAuthority" ADD CONSTRAINT "PlatformAuthority_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_id_fkey"
    FOREIGN KEY ("id") REFERENCES "PlatformAuthority"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Platform authority is independent of household membership. Replace the existing
-- session insert guard so a platform owner can authenticate even if every household
-- membership is suspended; household authorization remains independently denied.
CREATE OR REPLACE FUNCTION "require_active_membership_for_session"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM member."id"
  FROM "HouseholdMember" AS member
  INNER JOIN "Household" AS household ON household."id" = member."householdId"
  WHERE member."userId" = NEW."userId"
    AND member."deletedAt" IS NULL
    AND household."deletedAt" IS NULL
  ORDER BY member."id"
  FOR SHARE OF member;

  IF EXISTS (
    SELECT 1
    FROM "HouseholdMember" AS member
    INNER JOIN "Household" AS household ON household."id" = member."householdId"
    WHERE member."userId" = NEW."userId"
      AND member."disabledAt" IS NULL
      AND member."deletedAt" IS NULL
      AND household."deletedAt" IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PlatformAuthority"
    WHERE "ownerUserId" = NEW."userId"
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "HouseholdMember" AS member
    INNER JOIN "Household" AS household ON household."id" = member."householdId"
    WHERE member."userId" = NEW."userId"
      AND member."disabledAt" IS NOT NULL
      AND member."deletedAt" IS NULL
      AND household."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Your account is disabled.' USING ERRCODE = 'CUB01';
  END IF;

  RETURN NEW;
END;
$$;