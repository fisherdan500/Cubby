import type { ActivityTypeName } from "@/domain/activity";

export type DashboardTimer = { id: string; type: string };

/**
 * The running timers the quick-action grid does not already stand for.
 *
 * A tile can only stand for one timer, so it shows the first of its type. Everything else - the types
 * with no tile of their own, and a second timer of a type that already has one - needs its own row, or
 * it would be running with nothing on the screen to say so. Twins feeding at once, or a nap started
 * before the last one was stopped, are the ordinary cases.
 */
export function timersWithoutTile<T extends DashboardTimer>(
  activeTimers: readonly T[],
  tileTypes: ReadonlySet<ActivityTypeName>
): T[] {
  const shownOnATile = new Set(
    [...tileTypes]
      .map((type) => activeTimers.find((timer) => timer.type === type)?.id)
      .filter((id): id is string => Boolean(id))
  );
  return activeTimers.filter((timer) => !shownOnATile.has(timer.id));
}
