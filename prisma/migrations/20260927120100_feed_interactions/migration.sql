-- Comments, reactions and post edits in the private family feed (DEC-PROD-421). Comments and
-- reactions belong to a post or a logged entry - exactly one - and every reference carries the
-- household, so neither can point across households.
ALTER TABLE "FeedPost" ADD COLUMN "editedAt" TIMESTAMP(3);

CREATE TYPE "FeedReactionKind" AS ENUM ('love', 'funny', 'aww', 'celebrate', 'well_done');

CREATE TABLE "FeedComment" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "postId" TEXT,
    "activityId" TEXT,
    "authorMemberId" TEXT,
    "externalAuthorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedByMemberId" TEXT,

    CONSTRAINT "FeedComment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FeedComment_parent_check" CHECK (num_nonnulls("postId", "activityId") = 1),
    -- Every comment says who wrote it: a member, or the name carried over by a restore.
    CONSTRAINT "FeedComment_author_check" CHECK ("authorMemberId" IS NOT NULL OR "externalAuthorName" IS NOT NULL),
    CONSTRAINT "FeedComment_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 1000),
    CONSTRAINT "FeedComment_deleted_check" CHECK ("deletedAt" IS NOT NULL OR "deletedByMemberId" IS NULL)
);

CREATE TABLE "FeedReaction" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "postId" TEXT,
    "activityId" TEXT,
    "memberId" TEXT,
    "externalReactorName" TEXT,
    "reaction" "FeedReactionKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedReaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FeedReaction_parent_check" CHECK (num_nonnulls("postId", "activityId") = 1),
    CONSTRAINT "FeedReaction_reactor_check" CHECK ("memberId" IS NOT NULL OR "externalReactorName" IS NOT NULL)
);

CREATE INDEX "FeedComment_householdId_postId_createdAt_idx" ON "FeedComment"("householdId", "postId", "createdAt");

CREATE INDEX "FeedComment_householdId_activityId_createdAt_idx" ON "FeedComment"("householdId", "activityId", "createdAt");

CREATE UNIQUE INDEX "FeedComment_householdId_id_key" ON "FeedComment"("householdId", "id");

-- A member chooses each reaction once per post or entry. Restored reactions have no member, and
-- rows for the other kind of parent have no post (or entry), so neither collides here.
CREATE UNIQUE INDEX "FeedReaction_householdId_postId_memberId_reaction_key" ON "FeedReaction"("householdId", "postId", "memberId", "reaction");

CREATE UNIQUE INDEX "FeedReaction_householdId_activityId_memberId_reaction_key" ON "FeedReaction"("householdId", "activityId", "memberId", "reaction");

-- Lets comments and reactions reference an entry together with its household.
CREATE UNIQUE INDEX "ActivityLog_householdId_id_key" ON "ActivityLog"("householdId", "id");

ALTER TABLE "FeedComment" ADD CONSTRAINT "FeedComment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedComment" ADD CONSTRAINT "FeedComment_householdId_postId_fkey" FOREIGN KEY ("householdId", "postId") REFERENCES "FeedPost"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedComment" ADD CONSTRAINT "FeedComment_householdId_activityId_fkey" FOREIGN KEY ("householdId", "activityId") REFERENCES "ActivityLog"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedComment" ADD CONSTRAINT "FeedComment_householdId_authorMemberId_fkey" FOREIGN KEY ("householdId", "authorMemberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FeedReaction" ADD CONSTRAINT "FeedReaction_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedReaction" ADD CONSTRAINT "FeedReaction_householdId_postId_fkey" FOREIGN KEY ("householdId", "postId") REFERENCES "FeedPost"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedReaction" ADD CONSTRAINT "FeedReaction_householdId_activityId_fkey" FOREIGN KEY ("householdId", "activityId") REFERENCES "ActivityLog"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedReaction" ADD CONSTRAINT "FeedReaction_householdId_memberId_fkey" FOREIGN KEY ("householdId", "memberId") REFERENCES "HouseholdMember"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Editing a post binds to that post. Commenting and reacting bind to the post or entry they are on,
-- and editing or removing a comment binds to that comment. All are household-scoped, like posts.
-- Every other case is unchanged from 20260926120100_feed_post.
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
    WHEN 'feed_post.update' THEN "targetKind" = 'post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.create' THEN "targetKind" IN ('post', 'activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.update' THEN "targetKind" = 'comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.delete' THEN "targetKind" = 'comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_reaction.set' THEN "targetKind" IN ('post', 'activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    ELSE false
  END
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE "FeedComment" TO cubby_runtime';
    -- Turning a reaction off removes its row.
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE "FeedReaction" TO cubby_runtime';
  END IF;
END $$;
