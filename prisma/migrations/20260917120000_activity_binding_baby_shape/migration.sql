-- Every household-scoped browser operation on an existing activity - editing it, deleting it,
-- undoing the last one, and pausing/resuming/stopping a timer - failed with
-- 23514 BrowserOperationBinding_target_shape_check and surfaced as a 500, because the constraint
-- demanded "babyId" IS NOT NULL for those six keys while the code that issues them records no
-- babyId at all.
--
-- That is not an oversight in the code: household-scoped bindings deliberately carry no babyId, and
-- three separate places say so - issueHouseholdBrowserOperation writes `babyId: null`, its opening
-- fingerprint is computed with `babyId: null`, and householdBindingMatches requires
-- `binding.babyId === null` when replaying one. The baby is already identified by the activity the
-- binding targets. The constraint was therefore unsatisfiable by any code path, which is why zero
-- rows with these keys exist in any deployment.
--
-- The target shape stays enforced: these keys must still target an activity by id. The babyId
-- clause is aligned with the implementation rather than against it, so the invariant is real and
-- checkable instead of blocking the operations outright. Baby-scoped keys (activity.create,
-- baby.deactivate/reactivate, dashboard.warning.dismiss, calendar_event.create) are issued through
-- issueBrowserOperation, which does record babyId, and keep their IS NOT NULL requirement.
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
    WHEN 'notification.preference.save' THEN "targetKind" = 'preference' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'settings.units.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'calendar_event.create' THEN "targetKind" = 'calendar' AND "targetId" IS NULL AND "babyId" IS NOT NULL
    WHEN 'household.accent.update' THEN "targetKind" = 'settings' AND "targetId" IS NULL AND "babyId" IS NULL
    WHEN 'api_key.revoke' THEN "targetKind" = 'api_key' AND "targetId" IS NOT NULL AND "babyId" IS NULL
    ELSE false
  END
);
