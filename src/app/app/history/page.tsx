import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { DeleteActivityButton } from "@/components/actions/activity-actions";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Card } from "@/components/ui/card";
import { activityAccent, activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { describeActivity } from "@/lib/activity-format";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { listActivities } from "@/server/services/activities";
import { getHeaderBabySelector } from "@/server/services/baby-selector";

type HistoryActivity = Awaited<ReturnType<typeof listActivities>>[number];

export default async function HistoryPage({ searchParams }: { searchParams: { babyId?: string; type?: string; search?: string } }) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const activities = await listActivities({
    babyId: babySelector?.selectedBabyId ?? searchParams.babyId,
    type: searchParams.type,
    search: searchParams.search
  });
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const returnTo = historyHref({ babyId: selectedBabyId, type: searchParams.type, search: searchParams.search });
  const clearHref = historyHref({ babyId: selectedBabyId });
  const hasActiveFilters = Boolean(searchParams.type || searchParams.search);
  const groups = groupActivitiesByDay(activities, env.APP_TIMEZONE);

  return (
    <AppShell title="Full Log" userName={user.name} babySelector={babySelector}>
      <div className="space-y-4">
        <section className="rounded-lg border border-border bg-card/45 p-2">
          <AutoSubmitForm className="flex max-w-full flex-wrap items-center gap-2">
            {babySelector ? <input type="hidden" name="babyId" value={babySelector.selectedBabyId} /> : null}
            <select
              name="type"
              defaultValue={searchParams.type ?? ""}
              className="min-h-11 w-36 rounded-lg border border-border bg-card px-3 text-sm font-semibold sm:w-48"
            >
              <option value="">All types</option>
              {activityTypes.map((type) => (
                <option key={type} value={type}>
                  {activityLabels[type]}
                </option>
              ))}
            </select>
            <input
              name="search"
              defaultValue={searchParams.search ?? ""}
              placeholder="Search notes, meds, milestones"
              className="min-h-11 min-w-0 flex-1 basis-44 rounded-lg border border-border bg-card px-3 text-sm sm:max-w-80"
            />
            {hasActiveFilters ? (
              <Link
                href={clearHref}
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-muted px-3 text-sm font-black text-foreground hover:bg-border"
              >
                Clear
              </Link>
            ) : null}
          </AutoSubmitForm>
        </section>

        <div className="space-y-5">
          {activities.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">No matching activity yet.</p>
            </Card>
          ) : null}
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <div className="flex items-center justify-between gap-3 px-1">
                <h2 className="text-sm font-black">{dateGroupLabel(group.key, env.APP_TIMEZONE)}</h2>
                <span className="text-xs font-bold text-muted-foreground">
                  {group.activities.length} {group.activities.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <div className="space-y-2">
                {group.activities.map((activity) => (
                  <ActivityRow key={activity.id} activity={activity} returnTo={returnTo} timeZone={env.APP_TIMEZONE} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function ActivityRow({ activity, returnTo, timeZone }: { activity: HistoryActivity; returnTo: string; timeZone: string }) {
  const type = activity.type as ActivityTypeName;
  const actor = activity.actorMember.displayName ?? activity.actorMember.user.name;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-stretch">
        <Link href={activityEditHref(activity.id, returnTo)} className="min-w-0 flex-1 p-3 transition hover:bg-muted">
          <div className="flex items-start gap-3">
            <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${activityAccent[type].split(" ")[0]}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <p className="font-black leading-tight">{activityLabels[type]}</p>
                <p className="text-xs font-bold text-muted-foreground">{timeLabel(activity.occurredAt, timeZone)}</p>
              </div>
              <p className="mt-1 text-xs font-semibold text-muted-foreground">
                {activity.baby.name} - {actor}
              </p>
              <p className="mt-1 line-clamp-2 text-sm">{describeActivity(activity)}</p>
            </div>
          </div>
        </Link>
        <div className="flex shrink-0 items-center border-l border-border p-2">
          <DeleteActivityButton id={activity.id} returnTo={returnTo} />
        </div>
      </div>
    </Card>
  );
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
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function timeLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(date);
}

function historyHref(input: { babyId?: string; type?: string; search?: string }) {
  const params = new URLSearchParams();
  if (input.babyId) params.set("babyId", input.babyId);
  if (input.type) params.set("type", input.type);
  if (input.search) params.set("search", input.search);
  const query = params.toString();
  return query ? `/app/history?${query}` : "/app/history";
}

function activityEditHref(activityId: string, returnTo: string) {
  return `/app/activities/${activityId}/edit?${new URLSearchParams({ returnTo }).toString()}`;
}
