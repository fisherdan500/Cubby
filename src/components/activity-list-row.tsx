import Link from "next/link";
import { ActivityArtwork } from "@/components/activity-artwork";
import { SwipeRowActions } from "@/components/swipe-row-actions";
import { activityDayTimeLabel, activityLabels, type ActivityTypeName } from "@/domain/activity";
import type { VolumeUnit } from "@/domain/units";
import { describeActivity } from "@/lib/activity-format";
import { activityDetailHref, activityEditHref } from "@/lib/activity-navigation";
import type { ActivityRowActions } from "@/lib/activity-row-actions";

export type ActivityListItem = Parameters<typeof describeActivity>[0] & {
  id: string;
  occurredAt: Date;
  type: string;
  // Carried so a row that crosses midnight can say so; absent on older callers.
  startedAt?: Date | null;
  endedAt?: Date | null;
};

/**
 * One activity as a row: the artwork is the only visual anchor, then the name and a one-line summary,
 * with the time on the right. The dashboard timeline, the full log and the calendar's day sheet all use
 * this row so an activity looks the same wherever it is listed.
 *
 * Opening the activity replaces the list's history entry: the activity page's Back returns to the exact
 * list (returnTo), and the browser's own back does not bounce between the two.
 */
function dayTimeLabel(
  activity: ActivityListItem,
  day: { start: Date; end: Date } | undefined,
  timeZone: string
) {
  const startedAt = activity.startedAt ?? null;
  if (!day || !startedAt) {
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone }).format(activity.occurredAt);
  }
  return activityDayTimeLabel({ startedAt, endedAt: activity.endedAt ?? null }, day, timeZone).text;
}

export function ActivityListRow({
  activity,
  returnTo,
  timeZone,
  volume,
  meta,
  actions,
  day
}: {
  activity: ActivityListItem;
  returnTo: string;
  timeZone: string;
  volume: VolumeUnit;
  // A short line under the time, such as who recorded it. Omitted where it would only repeat context.
  meta?: string;
  // The day being viewed. Given it, an activity crossing midnight shows both ends with their dates;
  // without it the row falls back to the single recorded time.
  day?: { start: Date; end: Date };
  // What this member may do to the entry; a row with nothing allowed stays a plain link.
  actions?: ActivityRowActions;
}) {
  const type = activity.type as ActivityTypeName;
  const row = (
    <Link
      replace
      prefetch={false}
      href={activityDetailHref(activity.id, returnTo)}
      className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted"
    >
      <ActivityArtwork type={type} size="xs" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight">{activityLabels[type]}</p>
        <p className="truncate text-xs text-muted-foreground">{describeActivity(activity, { volume })}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-semibold tabular-nums text-muted-foreground">
          {dayTimeLabel(activity, day, timeZone)}
        </p>
        {meta ? <p className="max-w-24 truncate text-[0.6875rem] text-muted-foreground">{meta}</p> : null}
      </div>
    </Link>
  );
  if (!actions?.canUpdate && !actions?.canDelete) return row;
  return (
    <SwipeRowActions
      id={activity.id}
      returnTo={returnTo}
      editHref={actions.canUpdate ? activityEditHref(activity.id, returnTo) : undefined}
      canDelete={actions.canDelete}
    >
      {row}
    </SwipeRowActions>
  );
}
