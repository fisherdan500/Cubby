import { ActivityArtwork } from "@/components/activity-artwork";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";

/**
 * The same artwork the dashboard tile, the timeline row and the activity page use, so the form reads as
 * the next step of the tap that opened it rather than a generic page of fields.
 */
export function ActivityFormHeader({ type }: { type: ActivityTypeName }) {
  return (
    <header className="flex min-w-0 items-center gap-3 border-b border-border pb-4">
      <ActivityArtwork type={type} size="md" />
      <h2 className="truncate font-editorial text-xl font-black text-foreground">{activityLabels[type]}</h2>
    </header>
  );
}
