-- Its own migration: new enum values cannot be used in the transaction that adds them, and the next
-- migration's target-shape rule names them.
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_post.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_comment.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_comment.update';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_comment.delete';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_reaction.set';
ALTER TYPE "BrowserOperationTargetKind" ADD VALUE IF NOT EXISTS 'comment';
