import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { FeedActivityCard } from "@/components/feed/feed-activity-card";
import { Card } from "@/components/ui/card";
import { env } from "@/lib/env";
import { feedFilters, feedHref, groupFeedByDay, resolveFeedFilter } from "@/lib/feed";
import { historyPageQuery, paginateHistoryItems } from "@/lib/history-pagination";
import { requireUserPage } from "@/server/auth/session";
import { listActivities } from "@/server/services/activities";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

/**
 * The family feed (DEC-PROD-421): everything logged for the selected baby, newest first, as a
 * scrollable run of cards - the start of a private family journal. Posts, comments and reactions join
 * it in later steps. It is only ever the household's own entries, in time order: no ranking, counts or
 * anything designed to keep someone scrolling.
 */
export default async function FeedPage({
  searchParams
}: {
  searchParams: { babyId?: string; filter?: string; cursor?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const babyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const filter = resolveFeedFilter(searchParams.filter);
  const [results, unitSettings] = await Promise.all([
    listActivities({ babyId, type: filter.type, page: historyPageQuery(searchParams.cursor) }),
    getActivityUnitPreferences()
  ]);
  const { items, nextCursor } = paginateHistoryItems(results);
  const returnTo = feedHref({ babyId, filter: filter.key, cursor: searchParams.cursor });
  const groups = groupFeedByDay(items, env.APP_TIMEZONE);

  return (
    <AppShell title="Feed" userName={user.name} babySelector={babySelector}>
      <div className="mx-auto max-w-2xl space-y-5">
        <nav aria-label="Feed filters" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
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

        {groups.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              Nothing here yet.{filter.key === "all" ? " Everything logged will appear here as it happens." : " Try Everything to see all entries."}
            </p>
          </Card>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="space-y-2">
            <h2 className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1 text-sm font-semibold backdrop-blur md:top-20">
              {group.label}
            </h2>
            <ul className="space-y-2">
              {group.items.map((activity) => (
                <li key={activity.id}>
                  <FeedActivityCard
                    activity={activity}
                    returnTo={returnTo}
                    timeZone={env.APP_TIMEZONE}
                    volume={unitSettings.preferences.volume}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {searchParams.cursor || nextCursor ? (
          <nav aria-label="Feed pages" className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {searchParams.cursor ? (
              <Link
                href={feedHref({ babyId, filter: filter.key })}
                className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted"
              >
                Back to newest
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={feedHref({ babyId, filter: filter.key, cursor: nextCursor })}
                className="ml-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-control bg-card px-5 text-sm font-semibold hover:bg-muted"
              >
                Older entries
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </AppShell>
  );
}
