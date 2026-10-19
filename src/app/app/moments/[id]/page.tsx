import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { FeedPostCard } from "@/components/feed/feed-post-card";
import { FeedResponses } from "@/components/feed/feed-responses";
import { Card } from "@/components/ui/card";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { feedInteractionKey, listFeedInteractions } from "@/server/services/feed-interactions";
import { getFeedPostView } from "@/server/services/feed-posts";
import { markMomentsSeen } from "@/server/services/moments-seen";
import { getHouseholdHome } from "@/server/services/households";

/**
 * One moment, by itself: the landing for a notification tap and for choosing a moment from the
 * feed. The list keeps the day's rhythm; this page gives a single post the whole screen - photos,
 * caption, and the family's responses - so a tap on "Dana shared a moment" arrives AT the moment.
 *
 * A notification can outlive its moment, so a missing or removed post is a calm explanation with a
 * way back to Moments, never an error screen.
 */
export default async function MomentDetailPage({ params }: { params: { id: string } }) {
  const user = await requireUserPage();
  const home = await getHouseholdHome({ includeInactive: true });
  if (!home) redirect("/onboarding");

  // A notification tap lands here without passing the list; seeing one moment is seeing Moments.
  await markMomentsSeen().catch(() => undefined);
  const post = await getFeedPostView(params.id);

  if (!post) {
    return (
      <AppShell title="Moments" userName={user.name}>
        <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-4">
          <Card className="space-y-3 p-6 text-center">
            <p className="text-base font-semibold">This moment is gone</p>
            <p className="text-sm text-muted-foreground">
              It may have been removed, or the link is old. Everything the family has shared is
              still in Moments.
            </p>
            <p>
              <Link href="/app/moments" className="text-sm font-semibold text-primary hover:underline">
                Back to Moments
              </Link>
            </p>
          </Card>
        </div>
      </AppShell>
    );
  }

  const babySelector = await getHeaderBabySelector(user.id, post.babyId ?? undefined, { includeInactive: true });
  const babyName = post.babyId ? babySelector?.babies.find((baby) => baby.id === post.babyId)?.name : undefined;
  const interactions = await listFeedInteractions({ postIds: [post.id], activityIds: [] });
  const key = feedInteractionKey("post", post.id);

  return (
    <AppShell title="Moment" userName={user.name}>
      <div className="mx-auto w-full max-w-xl space-y-3 px-4 pb-10 pt-4">
        <p>
          <Link href="/app/moments" className="text-sm font-semibold text-primary hover:underline">
            ← All moments
          </Link>
        </p>
        <FeedPostCard
          post={post}
          babyId={post.babyId ?? undefined}
          babyName={babyName}
          timeZone={env.APP_TIMEZONE}
          footer={
            <FeedResponses
              parentKind="post"
              parentId={post.id}
              reactions={interactions?.reactions[key] ?? []}
              comments={interactions?.comments[key] ?? []}
              canRespond={interactions?.canRespond ?? false}
              timeZone={env.APP_TIMEZONE}
            />
          }
        />
      </div>
    </AppShell>
  );
}
