import Link from "next/link";
import { Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ActivityListRow } from "@/components/activity-list-row";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { activityLabels, activityTypes } from "@/domain/activity";
import { env } from "@/lib/env";
import { historyHref, historyPageQuery, paginateHistoryItems } from "@/lib/history-pagination";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { listActivities } from "@/server/services/activities";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

type HistoryActivity = Awaited<ReturnType<typeof listActivities>>[number];

export default async function HistoryPage({
  searchParams
}: {
  searchParams: { babyId?: string; type?: string; search?: string; cursor?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const [activityResults, unitSettings] = await Promise.all([
    listActivities({
      babyId: babySelector?.selectedBabyId ?? searchParams.babyId,
      type: searchParams.type,
      search: searchParams.search,
      page: historyPageQuery(searchParams.cursor)
    }),
    getActivityUnitPreferences()
  ]);
  const { items: activities, nextCursor } = paginateHistoryItems(activityResults);
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const returnTo = historyHref({
    babyId: selectedBabyId,
    type: searchParams.type,
    search: searchParams.search,
    cursor: searchParams.cursor
  });
  const clearHref = historyHref({ babyId: selectedBabyId });
  const hasActiveFilters = Boolean(searchParams.type || searchParams.search);
  const groups = groupActivitiesByDay(activities, env.APP_TIMEZONE);

  return (
    <AppShell title="Full Log" userName={user.name} babySelector={babySelector}>
      <div className="mx-auto max-w-3xl space-y-5">
        {/* Search leads, since that is what the log is opened for; the type filter sits beside it. */}
        <AutoSubmitForm className="flex max-w-full flex-wrap items-center gap-2">
          {babySelector ? <input type="hidden" name="babyId" value={babySelector.selectedBabyId} /> : null}
          <label htmlFor="history-search" className="sr-only">
            Search activity history
          </label>
          <div className="relative min-w-0 flex-1 basis-48">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="history-search" name="search" defaultValue={searchParams.search ?? ""} placeholder="Search notes, meds, milestones" className="pl-9" />
          </div>
          <label htmlFor="history-type" className="sr-only">
            Activity type
          </label>
          <Select id="history-type" name="type" defaultValue={searchParams.type ?? ""} className="w-36 sm:w-44">
            <option value="">All types</option>
            {activityTypes.map((type) => (
              <option key={type} value={type}>
                {activityLabels[type]}
              </option>
            ))}
          </Select>
          {hasActiveFilters ? (
            <Link href={clearHref} className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted">
              Clear
            </Link>
          ) : null}
        </AutoSubmitForm>

        {activities.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{hasActiveFilters ? "Nothing matches that search." : "No activity logged yet."}</p>
          </Card>
        ) : null}

        {/* One quiet card per day, the rows inside matching the dashboard timeline, so the log reads as
            the same list continued backwards rather than a stack of separate boxes. */}
        {groups.map((group) => (
          <section key={group.key} aria-label={dateGroupLabel(group.key, env.APP_TIMEZONE)} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h2 className="text-sm font-semibold">{dateGroupLabel(group.key, env.APP_TIMEZONE)}</h2>
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">{group.activities.length}</span>
            </div>
            <Card className="space-y-0.5 p-1.5">
              {group.activities.map((activity) => (
                <ActivityListRow
                  key={activity.id}
                  activity={activity}
                  returnTo={returnTo}
                  timeZone={env.APP_TIMEZONE}
                  volume={unitSettings.preferences.volume}
                  meta={actorName(activity)}
                />
              ))}
            </Card>
          </section>
        ))}

        {searchParams.cursor || nextCursor ? (
          <nav aria-label="Activity history pages" className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {searchParams.cursor ? (
              <Link
                href={historyHref({ babyId: selectedBabyId, type: searchParams.type, search: searchParams.search })}
                className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-bold text-primary hover:bg-muted"
              >
                Back to newest
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={historyHref({
                  babyId: selectedBabyId,
                  type: searchParams.type,
                  search: searchParams.search,
                  cursor: nextCursor
                })}
                className="ml-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-5 text-sm font-semibold hover:bg-muted"
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

function actorName(activity: HistoryActivity) {
  const name = activity.actorMember.displayName ?? activity.actorMember.user.name;
  const inactive = Boolean((activity.baby as { inactiveAt?: Date | null }).inactiveAt);
  // The baby is already chosen in the header; only an inactive baby's entries need to say so.
  return inactive ? `${name} · ${activity.baby.name} (inactive)` : name;
}

function groupActivitiesByDay(activities: HistoryActivity[], timeZone: string) {
  const groups: Array<{ key: string; activities: HistoryActivity[] }> = [];
  for (const activity of activities) {
    const key = dateKeyInTimeZone(activity.occurredAt, timeZone);
    const current = groups[groups.length - 1];
    if (current?.key === key) {
      current.activities.push(activity);
    } else {
      groups.push({ key, activities: [activity] });
    }
  }
  return groups;
}

function dateGroupLabel(key: string, timeZone: string) {
  const today = dateKeyInTimeZone(new Date(), timeZone);
  if (key === today) return "Today";
  if (key === addDaysToDateKey(today, -1)) return "Yesterday";

  const [year, month, day] = key.split("-").map(Number);
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
