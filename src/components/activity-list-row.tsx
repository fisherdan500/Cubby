import Link from "next/link";
import { ActivityArtwork } from "@/components/activity-artwork";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import type { VolumeUnit } from "@/domain/units";
import { describeActivity } from "@/lib/activity-format";
import { activityDetailHref } from "@/lib/activity-navigation";

export type ActivityListItem = Parameters<typeof describeActivity>[0] & { id: string; occurredAt: Date; type: string };

/**
 * One activity as a row: the artwork is the only visual anchor, then the name and a one-line summary,
 * with the time on the right. The dashboard timeline, the full log and the calendar's day sheet all use
 * this row so an activity looks the same wherever it is listed.
 *
 * Opening the activity replaces the list's history entry: the activity page's Back returns to the exact
 * list (returnTo), and the browser's own back does not bounce between the two.
 */
export function ActivityListRow({
  activity,
  returnTo,
  timeZone,
  volume,
  meta
}: {
  activity: ActivityListItem;
  returnTo: string;
  timeZone: string;
  volume: VolumeUnit;
  // A short line under the time, such as who recorded it. Omitted where it would only repeat context.
  meta?: string;
}) {
  const type = activity.type as ActivityTypeName;
  return (
    <Link
      replace
      prefetch={false}
      href={activityDetailHref(activity.id, returnTo)}
      className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted"
    >
      <ActivityArtwork type={type} size="xs" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black leading-tight">{activityLabels[type]}</p>
        <p className="truncate text-xs text-muted-foreground">{describeActivity(activity, { volume })}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-semibold tabular-nums text-muted-foreground">
          {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone }).format(activity.occurredAt)}
        </p>
        {meta ? <p className="max-w-24 truncate text-[0.6875rem] text-muted-foreground">{meta}</p> : null}
      </div>
    </Link>
  );
}
