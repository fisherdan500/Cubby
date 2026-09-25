-- Text posts in the private family feed (DEC-PROD-421). The baby and author references carry the
-- household, so a post can never point at another household's baby or member.
CREATE TABLE "FeedPost" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "babyId" TEXT,
    "authorMemberId" TEXT,
    "externalAuthorName" TEXT,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByMemberId" TEXT,

    CONSTRAINT "FeedPost_pkey" PRIMARY KEY ("id"),
    -- Every post says who wrote it: a member, or the name carried over by a restore.
    CONSTRAINT "FeedPost_author_check" CHECK ("authorMemberId" IS NOT NULL OR "externalAuthorName" IS NOT NULL),
    CONSTRAINT "FeedPost_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "FeedPost_deleted_check" CHECK ("deletedAt" IS NOT NULL OR "deletedByMemberId" IS NULL)
);

CREATE INDEX "FeedPost_householdId_babyId_occurredAt_idx" ON "FeedPost"("householdId", "babyId", "occurredAt");

CREATE INDEX "FeedPost_householdId_occurredAt_idx" ON "FeedPost"("householdId", "occurredAt");

CREATE UNIQUE INDEX "FeedPost_householdId_id_key" ON "FeedPost"("householdId", "id");

ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_householdId_authorMemberId_fkey" FOREIGN KEY ("householdId", "authorMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Creating a post binds to nothing yet; removing one binds to that post. Both are household-scoped,
-- as whole-family posts have no baby. Every other case is unchanged from 20260925120100_planned_schedule.
ALTER TABLE "BrowserOperationBinding" DROP CONSTRAINT "BrowserOperationBinding_target_shape_check";
ALTER TABLE "BrowserOperationBinding" ADD CONSTRAINT "BrowserOperationBinding_target_shape_check" CHECK (
  "persistenceVersion" = 1 OR
  CASE "operationKey"::text
    WHEN 'activity.create' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'activity.update' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.delete' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.undo_last' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.pause' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.resume' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'activity.timer.stop' THEN "targetKind" = 'activity' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'baby.create' THEN "targetKind" = 'baby' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'baby.deactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'baby.reactivate' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'dashboard.warning.dismiss' THEN "targetKind" = 'warning' AND "targetId" IS NOT NULL AND "babyId" IS NOT NULL
    WHEN 'invite.create' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'invite.revoke' THEN "targetKind" = 'invite' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'invite.revoke_all' THEN "targetKind" = 'invite' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'member.restore' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.remove' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.role.update' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'member.suspend' THEN "targetKind" = 'member' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'notification.preference.save' THEN "targetKind" = 'preference' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'settings.units.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'calendar_event.create' THEN "targetKind" = 'calendar' AND "targetId" IS NULL AND "babyId" IS NOT NULL
    WHEN 'household.accent.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'api_key.revoke' THEN "targetKind" = 'api_key' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'planned_schedule.save' THEN "targetKind" = 'baby' AND "targetId" = "babyId" AND "babyId" IS NOT NULL
    WHEN 'feed_post.create' THEN "targetKind" = 'post' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'feed_post.delete' THEN "targetKind" = 'post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    ELSE false
  END
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE "FeedPost" TO cubby_runtime';
  END IF;
END $$;
