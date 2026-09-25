import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { FeedActivityCard } from "@/components/feed/feed-activity-card";
import { FeedPostComposer } from "@/components/feed/feed-post-actions";
import { FeedPostCard } from "@/components/feed/feed-post-card";
import { FeedResponses } from "@/components/feed/feed-responses";
import { Card } from "@/components/ui/card";
import { attachmentTypeEnabled } from "@/domain/attachments";
import { hasPermission } from "@/domain/roles";
import { env } from "@/lib/env";
import { feedFilters, feedHref, groupFeedByDay, resolveFeedFilter } from "@/lib/feed";
import { historyPageQuery, paginateHistoryItems } from "@/lib/history-pagination";
import { requireUserPage } from "@/server/auth/session";
import { getActivityRowViewer, listActivities } from "@/server/services/activities";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { feedInteractionKey, listFeedInteractions } from "@/server/services/feed-interactions";
import { listFeedPosts, type FeedPostView } from "@/server/services/feed-posts";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

type ActivityItem = Awaited<ReturnType<typeof listActivities>>[number];
type FeedItem = { kind: "activity"; at: Date; activity: ActivityItem } | { kind: "post"; at: Date; post: FeedPostView };

/**
 * Moments, the family feed (DEC-PROD-421): everything logged for the selected baby and the family's posts,
 * newest first, as a scrollable run of cards - a private family journal. Whole-family posts appear
 * whichever baby is selected. It is only ever the household's own entries, in time order: no ranking,
 * counts or anything designed to keep someone scrolling.
 */
export default async function FeedPage({
  searchParams
}: {
  searchParams: { babyId?: string; filter?: string; tag?: string; cursor?: string; before?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const babyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const babyName = babySelector?.babies.find((baby) => baby.id === babyId)?.name;
  const filter = resolveFeedFilter(searchParams.filter);
  const tag = filter.posts === "only" && searchParams.tag ? searchParams.tag.toLowerCase() : undefined;
  const before = parseInstant(searchParams.before);
  const [unitSettings, viewer] = await Promise.all([getActivityUnitPreferences(), getActivityRowViewer()]);

  let items: FeedItem[];
  let nextCursor: string | undefined;
  let nextBefore: string | undefined;
  if (filter.posts === "only") {
    const page = paginateHistoryItems(await listFeedPosts({ babyId, tag, page: historyPageQuery(searchParams.cursor) }));
    items = page.items.map((post) => ({ kind: "post", at: post.occurredAt, post }));
    nextCursor = page.nextCursor;
  } else {
    const page = paginateHistoryItems(await listActivities({ babyId, type: filter.type, page: historyPageQuery(searchParams.cursor) }));
    const oldestShown = page.nextCursor ? page.items.at(-1)?.occurredAt : undefined;
    // Posts from the same stretch of time as this page of entries: from the oldest entry shown (when
    // there are older ones to come) up to where the previous page stopped.
    const posts = filter.posts === "mixed" ? await listFeedPosts({ babyId, from: oldestShown, to: before }) : [];
    items = [
      ...page.items.map((activity): FeedItem => ({ kind: "activity", at: activity.occurredAt, activity })),
      ...posts.map((post): FeedItem => ({ kind: "post", at: post.occurredAt, post }))
    ].sort((left, right) => right.at.getTime() - left.at.getTime());
    nextCursor = page.nextCursor;
    nextBefore = oldestShown?.toISOString();
  }

  const returnTo = feedHref({ babyId, filter: filter.key, tag, cursor: searchParams.cursor, before: searchParams.before });
  const groups = groupFeedByDay(items.map((item) => ({ ...item, occurredAt: item.at })), env.APP_TIMEZONE);
  const canPost = hasPermission(viewer.role, "feed.post");
  const interactions = await listFeedInteractions({
    postIds: items.flatMap((item) => item.kind === "post" ? [item.post.id] : []),
    activityIds: items.flatMap((item) => item.kind === "activity" ? [item.activity.id] : [])
  });
  const responses = (parentKind: "post" | "activity", parentId: string) => {
    const key = feedInteractionKey(parentKind, parentId);
    return (
      <FeedResponses
        parentKind={parentKind}
        parentId={parentId}
        reactions={interactions.reactions[key] ?? []}
        comments={interactions.comments[key] ?? []}
        canRespond={interactions.canRespond}
        timeZone={env.APP_TIMEZONE}
      />
    );
  };

  return (
    <AppShell title="Moments" userName={user.name} babySelector={babySelector}>
      <div className="mx-auto max-w-2xl space-y-5">
        <nav aria-label="Moments filters" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {feedFilters.map((option) => {
            const current = option.key === filter.key;
            return (
              <Link
                key={option.key}
                href={feedHref({ babyId, filter: option.key })}
                aria-current={current ? "true" : undefined}
                className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-bold ${
                  current ? "bg-primary text-primary-foreground" : "border border-control bg-card text-foreground hover:bg-muted"
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </nav>

        {tag ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Posts tagged #{tag}</p>
            <Link href={feedHref({ babyId, filter: "posts" })} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted">
              Clear
            </Link>
          </div>
        ) : null}

        {canPost && babyId && babyName && !searchParams.cursor ? (
          <FeedPostComposer babyId={babyId} babyName={babyName} photosEnabled={attachmentTypeEnabled("feed_photo")} />
        ) : null}

        {groups.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              Nothing here yet.{filter.key === "all" ? " Everything logged and shared will appear here as it happens." : " Try Everything to see all entries."}
            </p>
          </Card>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="space-y-2">
            <h2 className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1 text-sm font-semibold backdrop-blur md:top-20">
              {group.label}
            </h2>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item.kind === "post" ? `post-${item.post.id}` : item.activity.id}>
                  {item.kind === "post" ? (
                    <FeedPostCard
                      post={item.post}
                      babyId={babyId}
                      babyName={babyName}
                      timeZone={env.APP_TIMEZONE}
                      footer={responses("post", item.post.id)}
                    />
                  ) : (
                    <FeedActivityCard
                      activity={item.activity}
                      returnTo={returnTo}
                      timeZone={env.APP_TIMEZONE}
                      volume={unitSettings.preferences.volume}
                      footer={responses("activity", item.activity.id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {searchParams.cursor || nextCursor ? (
          <nav aria-label="Moments pages" className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {searchParams.cursor ? (
              <Link
                href={feedHref({ babyId, filter: filter.key, tag })}
                className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted"
              >
                Back to newest
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={feedHref({ babyId, filter: filter.key, tag, cursor: nextCursor, before: nextBefore })}
                className="ml-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-control bg-card px-5 text-sm font-semibold hover:bg-muted"
              >
                Older entries
              </Link>
            ) : null}
          </nav>
        ) : null}

        {canPost ? (
          <p className="text-center">
            <Link
              href={`/app/moments/removed${babyId ? `?babyId=${encodeURIComponent(babyId)}` : ""}`}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Recently removed
            </Link>
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

function parseInstant(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
