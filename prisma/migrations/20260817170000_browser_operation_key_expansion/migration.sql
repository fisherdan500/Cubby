-- Commit new browser-v2 operation keys before the foundation migration uses
-- them in v2 CHECK expressions. This migration contains no table mutation.
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.delete';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.undo_last';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.pause';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.resume';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'activity.timer.stop';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'baby.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.revoke';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'invite.revoke_all';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.restore';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.remove';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.role.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'member.suspend';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'notification.preference.save';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'settings.units.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'household.accent.update';
