-- Its own migration: a new enum value cannot be used in the transaction that adds it, and the next
-- migration's target-shape rule names it.
ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS 'feed_post.restore';
