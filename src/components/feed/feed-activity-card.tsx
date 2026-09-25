import Link from "next/link";
import { ActivityArtwork } from "@/components/activity-artwork";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import type { VolumeUnit } from "@/domain/units";
import { describeActivity } from "@/lib/activity-format";
import { activityDetailHref } from "@/lib/activity-navigation";

type FeedActivity = Parameters<typeof describeActivity>[0] & {
  actorMember?: { displayName: string | null; user: { name: string } } | null;
};

/**
 * One logged entry as a feed card: what it was, when, who logged it, and the part worth reading.
 * Milestones get more room, since they are the moments a family looks back for. The whole card opens
 * the entry, and the entry's Back returns to the feed exactly as it was.
 */
export function FeedActivityCard({
  activity,
  returnTo,
  timeZone,
  volume
}: {
  activity: FeedActivity;
  returnTo: string;
  timeZone: string;
  volume: VolumeUnit;
}) {
  const type = activity.type as ActivityTypeName;
  const label = activityLabels[type];
  const summary = describeActivity(activity, { volume });
  const milestone = type === "milestone";
  const author = activity.actorMember?.displayName ?? activity.actorMember?.user.name;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(activity.occurredAt);

  return (
    <Link
      replace
      prefetch={false}
      href={activityDetailHref(activity.id, returnTo)}
      className="block rounded-xl transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <article
        aria-label={label}
        className={`space-y-2 rounded-xl border p-3.5 ${milestone ? "border-primary/40 bg-primary/8" : "border-border bg-card"}`}
      >
        <header className="flex items-center gap-3">
          <ActivityArtwork type={type} size={milestone ? "md" : "sm"} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{label}</p>
            <p className="text-xs text-muted-foreground">
              <span className="tabular">{time}</span>
              {author ? ` · Logged by ${author}` : ""}
            </p>
          </div>
        </header>
        {summary ? (
          <p className={milestone ? "font-editorial text-lg font-semibold" : "text-sm text-foreground/90"}>{summary}</p>
        ) : null}
      </article>
    </Link>
  );
}
