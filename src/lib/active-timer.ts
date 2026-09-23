/**
 * How long a running timer has actually been running, and how to say it.
 *
 * `pausedSeconds` holds the pauses that have already finished; a pause in progress is not in it yet,
 * which is why a paused timer measures to `pausedAt` rather than to now. This is the same arithmetic
 * the stop path uses to write `durationSeconds`, so what a caregiver watches tick is what gets saved.
 */

export type ActiveTimerLike = {
  timerState: string;
  startedAt: string | null;
  pausedAt: string | null;
  pausedSeconds: number;
};

export const ACTIVE_TIMERS_CHANGED_EVENT = "cubby:active-timers-changed";

type ActiveTimerIdentity = { id: string; babyId: string; type: string };

export function activeTimerActionLabel(
  action: "Pause" | "Resume" | "Stop",
  babyName: string,
  typeLabel: string,
  timer: ActiveTimerIdentity,
  timers: ActiveTimerIdentity[]
) {
  const matchingTimers = timers.filter((candidate) =>
    candidate.babyId === timer.babyId && candidate.type === timer.type
  );
  const base = `${action} ${babyName}'s ${typeLabel.toLowerCase()} timer`;
  if (matchingTimers.length < 2) return base;
  const position = matchingTimers.findIndex((candidate) => candidate.id === timer.id);
  return position < 0 ? base : `${base} ${position + 1} of ${matchingTimers.length}`;
}

export function activeTimerElapsedSeconds(timer: ActiveTimerLike, now: number) {
  if (!timer.startedAt) return 0;
  const startedAt = Date.parse(timer.startedAt);
  if (Number.isNaN(startedAt)) return 0;
  const pausedAt = timer.pausedAt ? Date.parse(timer.pausedAt) : Number.NaN;
  // A paused timer is frozen at the moment it was paused, so the number stops moving on screen.
  const measuredTo = timer.timerState === "paused" && !Number.isNaN(pausedAt) ? pausedAt : now;
  return Math.max(0, Math.round((measuredTo - startedAt) / 1_000) - timer.pausedSeconds);
}

/** `0:42`, `12:04`, `1:12:04` - seconds matter while you are watching a feed. */
export function formatTimerElapsed(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours === 0) return `${minutes}:${paddedSeconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
}

/**
 * What a screen reader says. The ticking digits are deliberately not announced - a live region that
 * changed every second would talk over everything else - so the spoken form carries the same facts
 * in words, and only the running or paused state is announced when it changes.
 */
export function timerElapsedSpoken(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const parts = [
    hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    `${minutes} minute${minutes === 1 ? "" : "s"}`
  ].filter(Boolean);
  return parts.join(" ");
}
