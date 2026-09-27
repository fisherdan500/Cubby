// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

globalThis.React = React;
const mocks = vi.hoisted(() => ({ activities: vi.fn(), posts: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { activityLog: { findMany: mocks.activities }, feedPost: { findMany: mocks.posts } } }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: async () => ({ householdId: "home", memberId: "member", role: "parent" }),
  requirePermission: vi.fn()
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: async () => ({ id: "user", name: "Sam" }) }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: async () => ({ selectedBabyId: "baby", babies: [{ id: "baby", name: "Avery" }] }) }));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: async () => ({ preferences: {} }) }));
vi.mock("@/server/services/attachments", () => ({}));
vi.mock("@/server/services/audit", () => ({}));
vi.mock("@/server/services/browser-operations", () => ({}));
vi.mock("@/server/services/feed-interactions", () => ({ listFeedInteractions: async () => ({ comments: {}, reactions: {} }), feedInteractionKey: (k: string, id: string) => `${k}:${id}` }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", {}, children) }));
vi.mock("@/components/feed/feed-post-actions", () => ({ FeedPostComposer: () => null }));
vi.mock("@/components/feed/feed-responses", () => ({ FeedResponses: () => null }));
vi.mock("@/components/feed/feed-activity-card", () => ({ FeedActivityCard: ({ activity }: { activity: { id: string } }) => createElement("article", { "data-entry": `activity:${activity.id}` }) }));
vi.mock("@/components/feed/feed-post-card", () => ({ FeedPostCard: ({ post }: { post: { id: string; hasRetainedPhotos: boolean } }) => createElement("article", { "data-entry": `post:${post.id}`, "data-retained": String(post.hasRetainedPhotos) }) }));
import FeedPage from "@/app/app/moments/page";

type Row = { id: string; occurredAt: Date; householdId: string; babyId: string | null; deletedAt: Date | null; [key: string]: unknown };
type Where = Record<string, unknown>;
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part) => matches(row, part as Where));
    if (key === "OR") return (value as Where[]).some((part) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([op, bound]) => {
        const a = actual instanceof Date ? actual.getTime() : actual as string;
        const b = bound instanceof Date ? bound.getTime() : bound as string;
        if (op === "lt") return a < b;
        if (op === "lte") return a <= b;
        if (op === "gte") return a >= b;
        if (op === "equals") return a === b;
        throw new Error(`Unimplemented fixture predicate: ${op}`);
      });
    }
    return actual instanceof Date && value instanceof Date ? +actual === +value : actual === value;
  });
}
function source(rows: Row[]) {
  return async ({ where, take, orderBy, cursor, skip }: { where: Where; take: number; orderBy: unknown; cursor?: { id: string }; skip?: number }) => {
    expect(orderBy).toEqual([{ occurredAt: "desc" }, { id: "desc" }]);
    const sorted = rows.filter((row) => matches(row, where)).sort((a, b) => +b.occurredAt - +a.occurredAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start = cursor ? sorted.findIndex((row) => row.id === cursor.id) + (skip ?? 0) : 0;
    return sorted.slice(start, start + take);
  };
}
function row(id: string, at = "2026-09-25T12:00:00Z", extra: Partial<Row> = {}): Row {
  return { id, occurredAt: new Date(at), householdId: "home", babyId: null, deletedAt: null, author: null, photos: [], _count: { photos: 1 }, ...extra };
}
beforeEach(() => { vi.clearAllMocks(); });
it.each(["posts", "milestone"])("preserves ID-based pagination for the %s-only filter", async (filter) => {
  const rows = Array.from({ length: 31 }, (_, i) => row(`p${String(i).padStart(3, "0")}`, undefined, { babyId: "baby", type: "milestone" }));
  mocks.posts.mockImplementation(source(rows));
  mocks.activities.mockImplementation(source(rows));
  let cursor: string | undefined;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    document.body.innerHTML = renderToStaticMarkup(await FeedPage({ searchParams: { babyId: "baby", filter, cursor } }));
    seen.push(...[...document.querySelectorAll("[data-entry]")].map((card) => card.getAttribute("data-entry")!));
    const older = [...document.querySelectorAll("a")].find((link) => link.textContent === "Older entries");
    if (!older) break;
    const url = new URL(older.href);
    expect(url.searchParams.get("filter")).toBe(filter);
    cursor = url.searchParams.get("cursor")!;
    expect(cursor.startsWith("m1.")).toBe(false);
  }
  expect(seen).toEqual(rows.slice().reverse().map((r) => `${filter === "posts" ? "post" : "activity"}:${r.id}`));
  expect(filter === "posts" ? mocks.activities : mocks.posts).not.toHaveBeenCalled();
});


it("pages a dense mixed interval and ties within/across kinds without leaking other babies, tenants or removed rows", async () => {
  const posts = Array.from({ length: 231 }, (_, i) => row(`p${String(i).padStart(3, "0")}`, undefined, { babyId: i % 2 ? "baby" : null }));
  const activities = [row("new", "2026-09-26T12:00:00Z", { babyId: "baby", type: "milestone" }),
    ...Array.from({ length: 31 }, (_, i) => row(`p${String(i).padStart(3, "0")}`, undefined, { babyId: "baby", type: "milestone" })),
    row("old", "2026-09-24T12:00:00Z", { babyId: "baby", type: "milestone" })];
  const excluded = [row("other-baby", undefined, { babyId: "other" }), row("other-home", undefined, { householdId: "other" }), row("removed", undefined, { deletedAt: new Date() })];
  mocks.posts.mockImplementation(source([...posts, ...excluded]));
  mocks.activities.mockImplementation(source([...activities, ...excluded]));
  const expected = ["activity:new", ...posts.slice().reverse().map((p) => `post:${p.id}`), ...activities.slice(1, -1).reverse().map((p) => `activity:${p.id}`), "activity:old"];
  expect(await enumerate()).toEqual(expected);
  for (const [query] of mocks.posts.mock.calls) {
    expect(query.take).toBe(26);
    expect(query.where.OR).toEqual([{ babyId: "baby" }, { babyId: null }]);
  }
  for (const [query] of mocks.activities.mock.calls) {
    expect(query.take).toBe(26);
    expect(query.where).toMatchObject({ babyId: "baby", householdId: "home", deletedAt: null });
  }
});
it.each([0, 24, 25, 26, 50, 51])("terminates exactly at page boundaries (%i items)", async (count) => {
  const posts = Array.from({ length: count }, (_, i) => row(`p${String(i).padStart(3, "0")}`));
  mocks.posts.mockImplementation(source(posts));
  mocks.activities.mockImplementation(source([]));
  expect(await enumerate()).toEqual(posts.slice().reverse().map((p) => `post:${p.id}`));
  expect(mocks.posts).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 25)));
});
it.each(["legacy-id", "m1.invalid", "m1." + Buffer.from(JSON.stringify({ at: "invalid", kind: "post", id: "p" })).toString("base64url")])("restarts invalid/legacy cursors safely: %s", async (cursor) => {
  mocks.posts.mockImplementation(source([row("safe"), row("foreign", undefined, { householdId: "other" })]));
  mocks.activities.mockImplementation(source([]));
  expect(await enumerate(cursor)).toEqual(["post:safe"]);
});

async function enumerate(initialCursor?: string) {
  const seen: string[] = [];
  let cursor = initialCursor;
  for (let page = 0; page < 40; page++) {
    document.body.innerHTML = renderToStaticMarkup(await FeedPage({ searchParams: { babyId: "baby", cursor } }));
    const cards = [...document.querySelectorAll("[data-entry]")];
    expect(cards.length).toBeLessThanOrEqual(25);
    seen.push(...cards.map((card) => card.getAttribute("data-entry")!));
    const older = [...document.querySelectorAll("a")].find((link) => link.textContent === "Older entries");
    if (!older) return seen;
    const url = new URL(older.href);
    expect(url.searchParams.get("babyId")).toBe("baby");
    expect(url.searchParams.has("before")).toBe(false);
    cursor = url.searchParams.get("cursor") ?? undefined;
    expect(cursor).toBeTruthy();
    if (page > 0) expect(document.body.textContent).toContain("Back to newest");
  }
  throw new Error("Pagination did not terminate");
}

it("enumerates a post-only household beyond 200 through real page/service queries, with no gaps or duplicates", async () => {
  const posts = Array.from({ length: 231 }, (_, i) => row(`p${String(i).padStart(3, "0")}`));
  mocks.posts.mockImplementation(source(posts));
  mocks.activities.mockImplementation(source([]));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    document.body.innerHTML = renderToStaticMarkup(await FeedPage({ searchParams: { babyId: "baby", cursor } }));
    const cards = [...document.querySelectorAll("[data-entry]")];
    expect(cards.length).toBeLessThanOrEqual(25);
    expect(cards.every((card) => card.getAttribute("data-retained") === "true")).toBe(true);
    seen.push(...cards.map((card) => card.getAttribute("data-entry")!));
    const older = [...document.querySelectorAll("a")].find((link) => link.textContent === "Older entries");
    if (!older) break;
    cursor = new URL(older.href).searchParams.get("cursor") ?? undefined;
    expect(cursor).toBeTruthy();
  }
  expect(seen).toEqual(posts.slice().reverse().map((post) => `post:${post.id}`));
  for (const mock of [mocks.posts, mocks.activities]) for (const [query] of mock.mock.calls) {
    expect(query.take).toBe(26);
    expect(query.where).toMatchObject({ householdId: "home", deletedAt: null });
  }
});
