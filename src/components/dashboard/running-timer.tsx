import Link from "next/link";
import { ActivityArtwork } from "@/components/activity-artwork";
import { TimerDot, TimerElapsed } from "@/components/timer-elapsed";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";

/**
 * How a running timer appears on the dashboard: an indicator, and nothing else.
 *
 * These used to carry a Pause and a Stop button. Inside a third of a phone's width each button wrapped
 * onto its own lines, so a running tile towered over its neighbours and the grid jumped every time a
 * timer started. Stopping now lives in the shell's timer bar, which is one tap from any screen, and
 * pausing lives on the activity itself; tapping the indicator opens it.
 */

export type RunningTimerIndicator = {
  id: string;
  type: string;
  timerState: string;
  startedAt: Date | string | null;
  pausedAt: Date | string | null;
  pausedSeconds: number;
};

function elapsedProps(timer: RunningTimerIndicator) {
  const iso = (value: Date | string | null) =>
    value === null ? null : typeof value === "string" ? value : value.toISOString();
  return {
    timerState: timer.timerState,
    startedAt: iso(timer.startedAt),
    pausedAt: iso(timer.pausedAt),
    pausedSeconds: timer.pausedSeconds
  };
}

function activityHref(timer: RunningTimerIndicator) {
  return `/app/activities/${timer.id}?returnTo=${encodeURIComponent("/app")}`;
}

/** Replaces the quick-action tile for its type, at exactly the same height. */
export function RunningTimerTile({
  timer,
  label,
  nowMs
}: {
  timer: RunningTimerIndicator;
  label: string;
  nowMs: number;
}) {
  return (
    <Link
      href={activityHref(timer)}
      className="flex flex-col items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-1 py-2 text-center shadow-soft transition hover:bg-primary/16"
    >
      <ActivityArtwork type={timer.type as ActivityTypeName} size="lg" />
      <p className="text-sm font-black leading-tight text-foreground">{label}</p>
      <span className="flex min-h-4 items-center justify-center gap-1 text-xs font-black leading-tight text-primary">
        <TimerDot paused={timer.timerState === "paused"} />
        <TimerElapsed timer={elapsedProps(timer)} nowMs={nowMs} />
      </span>
    </Link>
  );
}

/** For a timer with no tile of its own: another type, or a second timer of a type that has one. */
export function RunningTimerRow({ timer, nowMs }: { timer: RunningTimerIndicator; nowMs: number }) {
  const type = timer.type as ActivityTypeName;
  return (
    <Link
      href={activityHref(timer)}
      className="flex min-h-11 items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 p-2 transition hover:bg-primary/16"
    >
      <TimerDot paused={timer.timerState === "paused"} />
      <ActivityArtwork type={type} size="xs" />
      <p className="min-w-0 flex-1 truncate text-sm font-black">{activityLabels[type]}</p>
      <TimerElapsed timer={elapsedProps(timer)} nowMs={nowMs} className="text-sm font-black text-primary" />
    </Link>
  );
}
