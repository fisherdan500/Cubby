-- A photo added to a logged entry.
--
-- The photo itself stays an ordinary feed photo on a real post: private delivery and the backup
-- export both select feed photos through their parent post, so a photo with no post would be
-- unreachable in the app and would silently travel in no backup. The post simply records which
-- entry it belongs to, and Moments presents the two as one moment.
--
-- Nullable because almost every post belongs to no entry, and every post that exists today has none.
ALTER TABLE "FeedPost" ADD COLUMN "activityId" TEXT;

-- Same-tenant by construction, exactly as "FeedComment"."activityId" already is: the link travels
-- through "householdId", so a post can never point at an entry in another household. A bare
-- activity id would make that only a convention enforced in application code.
ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_householdId_activityId_fkey" FOREIGN KEY ("householdId", "activityId") REFERENCES "ActivityLog"("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Moments asks for the photo posts of the entries on the page.
CREATE INDEX "FeedPost_householdId_activityId_idx" ON "FeedPost"("householdId", "activityId");
