import type { ActivityTypeName } from "@/domain/activity";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";

/**
 * The family feed (DEC-PROD-421): the household's own entries, newest first, one card each, for the
 * baby chosen at the top. The header filters narrow it to the kinds of entry people come looking for;
 * posts will join them when they exist.
 *
 * People see it as Moments, at /app/moments: "Feed" already means feeding the baby everywhere else in
 * Cubby. The code keeps the feed name; only what people read changed. /app/feed forwards here.
 */

// `posts` says whether a filter shows posts mixed with entries, posts alone, or entries alone.
export const feedFilters = [
  { key: "all", label: "Everything", type: undefined, posts: "mixed" },
  { key: "posts", label: "Posts", type: undefined, posts: "only" },
  { key: "feeding", label: "Feeds", type: "feeding", posts: "none" },
  { key: "sleep", label: "Sleep", type: "sleep", posts: "none" },
  { key: "diaper", label: "Diapers", type: "diaper", posts: "none" },
  { key: "milestone", label: "Milestones", type: "milestone", posts: "none" },
  { key: "note", label: "Notes", type: "note", posts: "none" }
] as const satisfies ReadonlyArray<{ key: string; label: string; type: ActivityTypeName | undefined; posts: "mixed" | "only" | "none" }>;

export type FeedFilter = (typeof feedFilters)[number];

export function resolveFeedFilter(value: string | undefined): FeedFilter {
  return feedFilters.find((filter) => filter.key === value) ?? feedFilters[0];
}

/**
 * `before` is the moment the next page continues from, so the posts shown alongside a page of entries
 * are exactly those from the same stretch of time - none skipped between pages, none shown twice.
 */
export function feedHref({ babyId, filter, tag, cursor, before }: { babyId?: string; filter?: string; tag?: string; cursor?: string; before?: string }) {
  const params = new URLSearchParams();
  if (babyId) params.set("babyId", babyId);
  if (filter && filter !== "all") params.set("filter", filter);
  if (tag) params.set("tag", tag);
  if (cursor) params.set("cursor", cursor);
  if (before) params.set("before", before);
  const query = params.toString();
  return query ? `/app/moments?${query}` : "/app/moments";
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
