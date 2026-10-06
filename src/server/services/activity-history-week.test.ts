import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { HouseholdContext } from "@/server/auth/context";
import { historyPageQuery } from "@/lib/history-pagination";
import type { MomentsBoundary } from "@/lib/moments-pagination";

const mocks = vi.hoisted(() => ({ permission: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "America/New_York" } }));
vi.mock("@/server/auth/context", () => ({ requirePermission: mocks.permission }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({}));
vi.mock("@/server/services/browser-operations", () => ({}));
vi.mock("@/server/services/activity-notifications", () => ({ queueActivityNotification: vi.fn() }));

import { activityInclude, listActivitiesForContext } from "@/server/services/activities";

const ctx: HouseholdContext = { householdId: "household-1", userId: "user-1", memberId: "member-1", role: "parent" };
function database() {
  const findMany = vi.fn().mockResolvedValue([]);
  const raw = vi.fn().mockResolvedValue([]);
  return {
    findMany, raw,
    client: { activityLog: { findMany }, $queryRaw: raw } as unknown as Pick<Prisma.TransactionClient, "activityLog" | "$queryRaw">
  };
}

describe("week-filtered activity history", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it("repeats household, deletion, baby, type, and all search guards in ID-only hydration", async () => {
    const db = database();
    const search = "Night_%";
    db.raw.mockResolvedValue([{ id: "selected" }]);
    db.findMany.mockResolvedValue([{ id: "selected" }]);
    await listActivitiesForContext(ctx, db.client, { week: "2026-03-02", babyId: "baby-1", type: "sleep", search, page: historyPageQuery("cursor") });
    const contains = { contains: search, mode: "insensitive" };
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany).toHaveBeenCalledWith({
      where: {
        householdId: ctx.householdId, deletedAt: null, babyId: "baby-1", type: "sleep", id: { in: ["selected"] },
        OR: [{ notes: contains }, { milestone: { title: contains } }, { note: { text: contains } },
          { medicine: { name: contains } }, { supplement: { name: contains } }, { vaccine: { name: contains } },
          { mood: { mood: contains } }, { play: { activityName: contains } }]
      }, include: activityInclude
    });
    expect(mocks.permission).toHaveBeenCalledWith(ctx, "activity.read");
  });

  it("checks activity.read before either week-query phase", async () => {
    const db = database();
    mocks.permission.mockImplementationOnce(() => { throw new Error("forbidden"); });
    await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02" })).rejects.toThrow("forbidden");
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("rejects a valid week with any Moments boundary before selector or hydration", async () => {
    const db = database();
    const kinds: MomentsBoundary["kind"][] = ["post", "activity"];
    for (const kind of kinds) {
      const momentsAfter: MomentsBoundary = { at: "2026-03-05T12:00:00.000Z", kind, id: "moment-1" };
      await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02", momentsAfter }))
        .rejects.toThrow(new Error("history_week_moments_boundary_unsupported"));
    }
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("anchors the cursor only in the fully matched set and limits deterministic paging to 26", async () => {
    const db = database();
    const cursor = "outside' OR TRUE --";
    await expect(listActivitiesForContext(ctx, db.client, {
      week: "2026-03-02", babyId: "baby-1", type: "sleep", search: "night", page: historyPageQuery(cursor)
    })).resolves.toEqual([]);
    const query = db.raw.mock.calls[0][0] as Prisma.Sql;
    const sql = query.sql.replace(/\s+/g, " ").trim();
    expect(sql).toContain('SELECT m."id" FROM matched m WHERE (m."occurredAt", m."id") < ( SELECT c."occurredAt", c."id" FROM matched c WHERE c."id" = ? ) ORDER BY m."occurredAt" DESC, m."id" DESC LIMIT ?');
    expect(query.values.slice(-2)).toEqual([cursor, 26]);
    expect(sql).not.toContain(cursor);
    expect(sql).not.toMatch(/OFFSET|UNION/);
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("emits sleepInterval endpoint precedence and strict positive half-open envelope membership", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-05T17:43:12.345Z");
    vi.setSystemTime(now);
    const db = database();
    await listActivitiesForContext(ctx, db.client, { week: "2026-03-02", type: "sleep" });
    const query = db.raw.mock.calls[0][0] as Prisma.Sql;
    const sql = query.sql.replace(/\s+/g, " ").trim();
    expect(sql).toContain('COALESCE(a."startedAt", a."occurredAt") AS "sleepStart"');
    // Ordered CASE branches pin ended > paused > running/malformed paused > duration > no interval.
    expect(sql).toContain(`CASE WHEN "endedAt" IS NOT NULL THEN GREATEST("sleepStart", "endedAt") WHEN "timerState" = 'paused' AND "pausedAt" IS NOT NULL THEN GREATEST("sleepStart", "pausedAt") WHEN "timerState" IN ('running', 'paused') THEN GREATEST("sleepStart", ?::timestamp) WHEN "durationSeconds" IS NOT NULL THEN "sleepStart" + "durationSeconds" * INTERVAL '1 second' ELSE NULL END AS "sleepEnd"`);
    // This excludes zero/negative durations, clamped reversed ends, and either touching edge.
    expect(sql).toContain(`OR ("type" = 'sleep' AND "sleepEnd" IS NOT NULL AND "sleepEnd" > "sleepStart" AND "sleepStart" < ? AND "sleepEnd" > ?)`);
    expect(sql).toContain('SELECT "id", "occurredAt" FROM intervals WHERE');
    expect(sql).toContain('SELECT scoped.*, CASE');
    expect(sql).toContain('END AS "sleepEnd" FROM scoped');
    expect(query.values).toEqual([ctx.householdId, "sleep", now,
      new Date("2026-03-02T05:00:00Z"), new Date("2026-03-09T04:00:00Z"),
      new Date("2026-03-09T04:00:00Z"), new Date("2026-03-02T05:00:00Z"), 26]);
    expect(query.values.filter((value) => value instanceof Date && value.getTime() === now.getTime())).toHaveLength(1);
    expect(sql).not.toMatch(/pausedSeconds|pauseIntervals|ActivityTimerPauseInterval|CURRENT_TIMESTAMP|NOW\(/i);
  });

  it("parameterizes all scope and eight search arms before the instant week predicate", async () => {
    const db = database();
    const search = "%' OR TRUE; --";
    const babyId = "baby' OR TRUE --";
    await listActivitiesForContext(ctx, db.client, { week: "2026-03-02", babyId, type: "feeding", search });
    const query = db.raw.mock.calls[0][0] as Prisma.Sql;
    expect(query).toBeInstanceOf(Prisma.sql``.constructor);
    const sql = query.sql.replace(/\s+/g, " ").trim();
    expect(sql).toContain('WITH scoped AS (');
    expect(sql).toContain('a."householdId" = ? AND a."deletedAt" IS NULL');
    expect(sql).toContain('AND a."babyId" = ?');
    expect(sql).toContain('AND a."type" = ?::"ActivityType"');
    expect(sql).toContain('AND ( a."notes" ILIKE ?');
    for (const [table, field] of [["MilestoneLog", "title"], ["NoteLog", "text"], ["MedicineLog", "name"], ["SupplementLog", "name"], ["VaccineLog", "name"], ["MoodLog", "mood"], ["PlayLog", "activityName"]]) {
      expect(sql).toContain(`OR EXISTS (SELECT 1 FROM "${table}" d WHERE d."activityId" = a."id" AND d."${field}" ILIKE ?)`);
    }
    expect(sql.match(/ILIKE \?/g)).toHaveLength(8);
    expect(sql).toContain('("type" <> \'sleep\' AND "occurredAt" >= ? AND "occurredAt" < ?)');
    expect(query.values.slice(0, 11)).toEqual([ctx.householdId, babyId, "feeding", ...Array(8).fill(`%${search}%`)]);
    expect(query.values).toEqual(expect.arrayContaining([new Date("2026-03-02T05:00:00Z"), new Date("2026-03-09T04:00:00Z"), 26]));
    for (const value of [ctx.householdId, babyId, search, "2026-03-02"]) expect(sql).not.toContain(value);
  });

  it("returns an empty raw page without hydration", async () => {
    const db = database();
    await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02" })).resolves.toEqual([]);
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("fails closed when hydration adds or substitutes IDs, including duplicates", async () => {
    const db = database();
    db.raw.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    for (const rows of [[{ id: "a" }, { id: "b" }, { id: "other-household" }], [{ id: "a" }, { id: "other-household" }], [{ id: "a" }, { id: "a" }]]) {
      db.findMany.mockResolvedValue(rows);
      await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02" })).rejects.toThrow("history_week_hydration_mismatch");
    }
  });

  it("fails closed when hydration omits a selected ID", async () => {
    const db = database();
    db.raw.mockResolvedValue([{ id: "b" }, { id: "a" }]);
    db.findMany.mockResolvedValue([{ id: "b" }]);
    await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02" })).rejects.toThrow("history_week_hydration_mismatch");
  });

  it("hydrates selected IDs in raw order even when Prisma returns another order", async () => {
    const db = database();
    db.raw.mockResolvedValue([{ id: "b" }, { id: "a" }]);
    db.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await expect(listActivitiesForContext(ctx, db.client, { week: "2026-03-02" })).resolves.toEqual([{ id: "b" }, { id: "a" }]);
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany).toHaveBeenCalledWith({
      where: { householdId: ctx.householdId, deletedAt: null, id: { in: ["b", "a"] } }, include: activityInclude
    });
  });

  it("keeps absent-week Prisma cursor pagination and defaults unchanged", async () => {
    const db = database();
    const page = historyPageQuery("cursor-25");
    const row = { id: "existing-row" };
    db.findMany.mockResolvedValue([row]);
    await expect(listActivitiesForContext(ctx, db.client, { babyId: "baby-1", type: "note", search: "hello", page })).resolves.toEqual([row]);
    expect(db.findMany).toHaveBeenCalledWith({
      where: { householdId: ctx.householdId, deletedAt: null, babyId: "baby-1", type: "note", OR: expect.any(Array) },
      include: activityInclude, ...page
    });
    await listActivitiesForContext(ctx, db.client);
    expect(db.findMany).toHaveBeenLastCalledWith({
      where: { householdId: ctx.householdId, deletedAt: null }, include: activityInclude,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 100
    });
    expect(db.raw).not.toHaveBeenCalled();
    expect(mocks.permission).toHaveBeenCalledWith(ctx, "activity.read");
  });

  it("rejects every present invalid week before selector or hydration", async () => {
    const db = database();
    for (const week of ["", "2026-2-02", "2026-02-30", "2026-02-03", ["2026-02-02"], ["2026-02-02", "2026-02-02"]]) {
      await expect(listActivitiesForContext(ctx, db.client, { week })).rejects.toThrow("invalid_history_week");
    }
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.findMany).not.toHaveBeenCalled();
  });
});
