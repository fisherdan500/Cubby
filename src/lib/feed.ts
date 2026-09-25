import type { ActivityTypeName } from "@/domain/activity";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";

/**
 * The family feed (DEC-PROD-421): the household's own entries, newest first, one card each, for the
 * baby chosen at the top. The header filters narrow it to the kinds of entry people come looking for;
 * posts will join them when they exist.
 */

export const feedFilters = [
  { key: "all", label: "Everything", type: undefined },
  { key: "feeding", label: "Feeds", type: "feeding" },
  { key: "sleep", label: "Sleep", type: "sleep" },
  { key: "diaper", label: "Diapers", type: "diaper" },
  { key: "milestone", label: "Milestones", type: "milestone" },
  { key: "note", label: "Notes", type: "note" }
] as const satisfies ReadonlyArray<{ key: string; label: string; type: ActivityTypeName | undefined }>;

export type FeedFilter = (typeof feedFilters)[number];

export function resolveFeedFilter(value: string | undefined): FeedFilter {
  return feedFilters.find((filter) => filter.key === value) ?? feedFilters[0];
}

export function feedHref({ babyId, filter, cursor }: { babyId?: string; filter?: string; cursor?: string }) {
  const params = new URLSearchParams();
  if (babyId) params.set("babyId", babyId);
  if (filter && filter !== "all") params.set("filter", filter);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/app/feed?${query}` : "/app/feed";
}

/** Entries grouped under the household's own days, labelled the way people talk about them. */
export function groupFeedByDay<T extends { occurredAt: Date }>(items: T[], timeZone: string, now = new Date()) {
  const todayKey = dateKeyInTimeZone(now, timeZone);
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    const key = dateKeyInTimeZone(item.occurredAt, timeZone);
    const current = groups.at(-1);
    if (current?.key === key) current.items.push(item);
    else groups.push({ key, label: dayLabel(key, todayKey), items: [item] });
  }
  return groups;
}

function dayLabel(key: string, todayKey: string) {
  if (key === todayKey) return "Today";
  if (key === addDaysToDateKey(todayKey, -1)) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(key.slice(0, 4) === todayKey.slice(0, 4) ? {} : { year: "numeric" as const }),
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
