-- Saving notification preferences failed with 23514 BrowserOperationBinding_target_shape_check.
-- The preference operation binds its target to the acting member (targetId = ctx.memberId), which
-- 20260818110000_membership_episode_notification_preferences correctly required with
-- "targetId" IS NOT NULL. 20260824120100_api_key_containment_target_shape re-listed every case and
-- reverted that one clause to IS NULL, and 20260917120000_activity_binding_baby_shape carried the
-- revert forward unchanged, so the preference save has been unsatisfiable since 2026-08-24. No row
-- with this key exists in any deployment, which is what an unsatisfiable constraint looks like.
--
-- This restores the 2026-08-18 clause. Every other case is unchanged from 20260917120000.
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
    ELSE false
  END
);
