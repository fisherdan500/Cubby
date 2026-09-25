-- Its own migration: new enum values cannot be used in the transaction that adds them, and the next
-- migration's target-shape rule names them.
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_post.create';
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_post.delete';
ALTER TYPE "BrowserOperationTargetKind" ADD VALUE IF NOT EXISTS 'post';
