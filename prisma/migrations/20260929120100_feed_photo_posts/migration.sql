-- Photo posts (DEC-PROD-422): a post may be photos alone, so its caption may now be empty. That a
-- post has words or photos is enforced where it is written, since the photos live in another table.
ALTER TABLE "FeedPost" DROP CONSTRAINT "FeedPost_body_check";
ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_body_check" CHECK (char_length(btrim("body")) <= 2000);

-- Bringing a removed post back binds to that post. Every other case is unchanged from
-- 20260927120100_feed_interactions.
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
    WHEN 'feed_post.restore' THEN "targetKind" = 'post' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.create' THEN "targetKind" IN ('post', 'activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.update' THEN "targetKind" = 'comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_comment.delete' THEN "targetKind" = 'comment' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    WHEN 'feed_reaction.set' THEN "targetKind" IN ('post', 'activity') AND "targetId" IS NOT NULL AND "babyId" IS NULL
    ELSE false
  END
);
