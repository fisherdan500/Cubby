import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { FeedPostRestoreButton } from "@/components/feed/feed-post-actions";
import { Card } from "@/components/ui/card";
import { FEED_POST_RECOVERY_MS } from "@/domain/feed-post";
import { env } from "@/lib/env";
import { feedHref } from "@/lib/feed";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { listRemovedFeedPosts } from "@/server/services/feed-posts";

const DAY_MS = 24 * 60 * 60 * 1000;

function timeLeft(deletedAt: Date, now: Date) {
  const days = Math.floor((deletedAt.getTime() + FEED_POST_RECOVERY_MS - now.getTime()) / DAY_MS);
  if (days < 1) return "Less than a day left";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/**
 * Posts removed in the last thirty days, and their photos, that this member may bring back: their
 * own, or everyone's for owners, admins and parents (DEC-PROD-146). After that they are gone for good.
 */
export default async function RemovedFeedPostsPage({ searchParams }: { searchParams: { babyId?: string } }) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const babyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const posts = await listRemovedFeedPosts();
  const now = new Date();
  const removedOn = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: env.APP_TIMEZONE });

  return (
    <AppShell title="Recently removed" userName={user.name} babySelector={babySelector}>
      <div className="mx-auto max-w-2xl space-y-4">
        <Link href={feedHref({ babyId })} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted">
          Back to Moments
        </Link>
        <p className="text-sm text-muted-foreground">Removed posts and their photos can be brought back for 30 days. After that they are gone for good.</p>

        {posts.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">Nothing removed in the last 30 days.</p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {posts.map((post) => (
              <li key={post.id}>
                <article aria-label="Removed post" className="space-y-2 rounded-xl border border-border bg-card p-3.5">
                  <header>
                    <p className="text-sm font-semibold">{post.authorName}</p>
                    <p className="text-xs text-muted-foreground">
                      Removed {removedOn.format(post.deletedAt)} · {timeLeft(post.deletedAt, now)}
                    </p>
                  </header>
                  {post.body ? <p className="line-clamp-3 whitespace-pre-line break-words text-sm">{post.body}</p> : null}
                  {post.photoCount ? (
                    <p className="text-xs text-muted-foreground">{post.photoCount} {post.photoCount === 1 ? "photo" : "photos"}</p>
                  ) : null}
                  <FeedPostRestoreButton postId={post.id} />
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
