/**
 * An overnight sleep on both days, against real PostgreSQL.
 *
 * The unit tests pin the rule; this proves the query actually returns the sleep on the morning the
 * family woke up, with real rows and a real day window. The defect it guards was invisible to every
 * unit test because the query itself was what filtered the sleep away.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { activityDayAnchor } from "@/domain/activity";
import { historyPageQuery, paginateHistoryItems } from "@/lib/history-pagination";
import { resolveHistoryWeek } from "@/lib/history-week";
import type { HouseholdContext } from "@/server/auth/context";
import { listActivitiesForContext } from "@/server/services/activities";
import { selectHistoryWeekIds } from "@/server/services/activity-history-week";
import { dayLogWhere } from "@/server/services/dashboard";

const prisma = new PrismaClient();
const householdId = `h-${randomUUID()}`;
const userId = `u-${randomUUID()}`;
let babyId = "";
let memberId = "";

// Sep 27 -> Sep 28 2026 in New York, so the day boundary is 04:00Z and a UTC-anchored bug fails.
const sep27 = { start: new Date("2026-09-27T04:00:00.000Z"), end: new Date("2026-09-28T04:00:00.000Z") };
const sep28 = { start: new Date("2026-09-28T04:00:00.000Z"), end: new Date("2026-09-29T04:00:00.000Z") };

const overnightStart = new Date("2026-09-28T00:44:00.000Z"); // Sep 27 8:44pm EDT
const overnightEnd = new Date("2026-09-28T12:30:00.000Z"); // Sep 28 8:30am EDT

async function logIds(day: { start: Date; end: Date }) {
  const rows = await prisma.activityLog.findMany({
    where: { householdId, babyId, deletedAt: null, ...dayLogWhere(day) },
    select: { id: true, startedAt: true, endedAt: true, occurredAt: true }
  });
  return rows;
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Parent", emailVerified: true } });
  await prisma.household.create({ data: { id: householdId, name: "Overnight House", createdByUserId: userId } });
  const member = await prisma.householdMember.create({
    data: { householdId, userId, role: "owner", joinedAt: new Date() }
  });
  memberId = member.id;
  const baby = await prisma.baby.create({ data: { householdId, name: "Overnight Baby", timezone: "America/New_York" } });
  babyId = baby.id;
});

// Stage 3C-DB shares the disposable rehearsal and client, but no original fixture scope.
const trendsScope = {
  userId: "trends-stage3c-db-user",
  householdId: "trends-stage3c-db-household",
  memberId: "trends-stage3c-db-member",
  temporalBabyId: "trends-stage3c-db-temporal-baby",
  pageBabyId: "trends-stage3c-db-page-baby",
  otherBabyId: "trends-stage3c-db-other-baby",
  foreignHouseholdId: "trends-stage3c-db-foreign-household",
  foreignMemberId: "trends-stage3c-db-foreign-member",
  foreignBabyId: "trends-stage3c-db-foreign-baby"
};
const trendsContext: HouseholdContext = { ...trendsScope, role: "owner" };
const trendsWeekKey = "2026-03-02";
// New York's spring-forward week is 167 hours: Monday 00:00 EST -> Monday 00:00 EDT.
const trendsWeekStart = new Date("2026-03-02T05:00:00.000Z");
const trendsWeekEnd = new Date("2026-03-09T04:00:00.000Z");
const beforeWeekStart = new Date("2026-03-02T04:30:00.000Z");
const insideWeek = new Date("2026-03-04T17:00:00.000Z");
const trendsId = (index: number) => `3cdb0000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function trendsActivity(index: number, data: Partial<Prisma.ActivityLogUncheckedCreateInput>): Prisma.ActivityLogUncheckedCreateInput {
  return {
    id: trendsId(index), householdId: trendsScope.householdId,
    babyId: trendsScope.temporalBabyId, actorMemberId: trendsScope.memberId,
    type: "sleep", occurredAt: beforeWeekStart, startedAt: beforeWeekStart,
    timezone: "America/New_York", ...data
  };
}

describe("Stage 3C-DB week-filtered history", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: {
      id: trendsScope.userId, email: "trends-stage3c-db@example.test", name: "Synthetic Parent", emailVerified: true
    } });
    for (const [id, member] of [
      [trendsScope.householdId, trendsScope.memberId],
      [trendsScope.foreignHouseholdId, trendsScope.foreignMemberId]
    ]) {
      await prisma.household.create({ data: { id, name: "Synthetic Trends Household", createdByUserId: trendsScope.userId } });
      await prisma.householdMember.create({ data: {
        id: member, householdId: id, userId: trendsScope.userId, role: "owner", joinedAt: insideWeek
      } });
    }
    await prisma.baby.createMany({ data: [
      ...[trendsScope.temporalBabyId, trendsScope.pageBabyId, trendsScope.otherBabyId].map((id) => ({
        id, householdId: trendsScope.householdId, name: "Synthetic Trends Baby", timezone: "America/New_York"
      })),
      { id: trendsScope.foreignBabyId, householdId: trendsScope.foreignHouseholdId, name: "Synthetic Foreign Baby", timezone: "America/New_York" }
    ] });
  });

  it("returns exact temporal IDs in a DST-transition Monday-to-Monday week", async () => {
    const fixtures = [
      trendsActivity(1, { type: "feeding", occurredAt: trendsWeekStart, startedAt: trendsWeekStart }),
      trendsActivity(2, { type: "feeding", occurredAt: trendsWeekEnd, startedAt: trendsWeekEnd }),
      trendsActivity(3, { type: "feeding", occurredAt: new Date("2026-03-09T03:59:59.999Z"), startedAt: null }),
      trendsActivity(4, { type: "feeding", occurredAt: new Date("2026-03-02T04:59:59.999Z"), endedAt: insideWeek }),
      trendsActivity(5, { endedAt: new Date("2026-03-02T05:00:00.001Z") }),
      trendsActivity(6, { endedAt: trendsWeekStart }),
      trendsActivity(7, { occurredAt: trendsWeekEnd, startedAt: trendsWeekEnd, endedAt: new Date("2026-03-09T05:00:00.000Z") }),
      trendsActivity(8, { durationSeconds: 1801 }),
      trendsActivity(9, { durationSeconds: 1800 }),
      trendsActivity(10, { startedAt: null, durationSeconds: 1801 }),
      trendsActivity(11, { startedAt: null, durationSeconds: 1800 }),
      trendsActivity(12, { startedAt: null, endedAt: new Date("2026-03-02T05:00:00.001Z") }),
      trendsActivity(13, { timerState: "running", pauseTrackingStartedAt: beforeWeekStart, pauseTrackingBaselineSeconds: 0 }),
      trendsActivity(14, {
        occurredAt: insideWeek, startedAt: insideWeek, timerState: "running",
        pauseTrackingStartedAt: insideWeek, pauseTrackingBaselineSeconds: 0
      }),
      trendsActivity(15, {
        occurredAt: trendsWeekEnd, startedAt: trendsWeekEnd, timerState: "running",
        pauseTrackingStartedAt: trendsWeekEnd, pauseTrackingBaselineSeconds: 0
      }),
      trendsActivity(16, {
        timerState: "paused", pausedAt: new Date("2026-03-02T05:00:00.001Z"),
        pauseTrackingStartedAt: beforeWeekStart, pauseTrackingBaselineSeconds: 0
      }),
      trendsActivity(17, {
        timerState: "paused", pausedAt: trendsWeekStart,
        pauseTrackingStartedAt: beforeWeekStart, pauseTrackingBaselineSeconds: 0
      }),
      trendsActivity(18, { occurredAt: insideWeek, startedAt: insideWeek }),
      trendsActivity(19, { occurredAt: insideWeek, startedAt: null })
    ];
    // The paused row and its one matching open interval must commit together under the deferred guard.
    await prisma.$transaction(async (tx) => {
      for (const data of fixtures) {
        await tx.activityLog.create({ data });
        if (data.timerState === "paused") {
          await tx.activityTimerPauseInterval.create({ data: {
            id: `${data.id}-pause`, activityId: data.id!, startedAt: data.pausedAt!, endedAt: null
          } });
        }
      }
    });

    const fixedIds = [1, 3, 5, 8, 10, 12, 16].map(trendsId);
    // Only Date is faked; PostgreSQL I/O and Vitest timeouts retain real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [now, runningIds] of [
        [trendsWeekStart, []],
        [new Date("2026-03-02T05:30:00.000Z"), [13]],
        [new Date("2026-03-10T05:00:00.000Z"), [13, 14]]
      ] as const) {
        vi.setSystemTime(now);
        const rows = await listActivitiesForContext(trendsContext, prisma, {
          week: trendsWeekKey, babyId: trendsScope.temporalBabyId, page: historyPageQuery()
        });
        expect(rows.map(({ id }) => id).sort()).toEqual([...fixedIds, ...runningIds.map(trendsId)].sort());
      }
    } finally {
      vi.useRealTimers();
    }
  });

  describe("scope, search, and deterministic pagination", () => {
    const filters = { week: trendsWeekKey, babyId: trendsScope.pageBabyId, type: "note", search: "stage3cneedle" };
    const expectedIds = Array.from({ length: 27 }, (_, index) => trendsId(127 - index));
    const hostileIds = [201, 202, 203, 204, 205, 206].map(trendsId);

    beforeAll(async () => {
      // A permutation avoids relying on insertion order to match the UUID tie-breaker.
      for (let index = 0; index < 27; index += 1) {
        const offset = (index * 7) % 27;
        await prisma.activityLog.create({ data: trendsActivity(101 + offset, {
          babyId: trendsScope.pageBabyId, type: "note", occurredAt: insideWeek, startedAt: null,
          notes: offset % 2 === 0 ? "Synthetic STAGE3CNEEDLE notes" : null,
          note: { create: { text: offset % 2 === 1 || offset === 0 ? "Synthetic STAGE3CNEEDLE subtype" : "Synthetic unrelated text" } }
        }) });
      }
      const hostileOverrides: Partial<Prisma.ActivityLogUncheckedCreateInput>[] = [
        { householdId: trendsScope.foreignHouseholdId, babyId: trendsScope.foreignBabyId, actorMemberId: trendsScope.foreignMemberId },
        { babyId: trendsScope.otherBabyId },
        { deletedAt: insideWeek },
        { type: "feeding" },
        { notes: "Synthetic unrelated notes" },
        { occurredAt: trendsWeekEnd }
      ];
      for (const [index, overrides] of hostileOverrides.entries()) {
        await prisma.activityLog.create({ data: trendsActivity(201 + index, {
          babyId: trendsScope.pageBabyId, type: "note", occurredAt: insideWeek, startedAt: null,
          notes: "Synthetic STAGE3CNEEDLE notes", ...overrides
        }) });
      }
    });

    it("walks the returned cursor through all 27 IDs once and hydrates in selector order", async () => {
      const week = resolveHistoryWeek(trendsWeekKey, "America/New_York");
      if (week.status !== "valid") throw new Error("stage3c_fixture_week_invalid");
      const readPage = async (cursor?: string) => {
        const selected = await selectHistoryWeekIds(prisma, trendsScope.householdId, week, filters, cursor);
        const rows = await listActivitiesForContext(trendsContext, prisma, { ...filters, page: historyPageQuery(cursor) });
        expect(rows.map(({ id }) => id)).toEqual(selected.map(({ id }) => id));
        return { selectedIds: selected.map(({ id }) => id), ...paginateHistoryItems(rows) };
      };
      const first = await readPage();
      expect(first.selectedIds).toEqual(expectedIds.slice(0, 26));
      expect(first.items.map(({ id }) => id)).toEqual(expectedIds.slice(0, 25));
      expect(first.items.length).toBeLessThanOrEqual(25);
      expect(first.nextCursor).toBe(expectedIds[24]);
      if (!first.nextCursor) throw new Error("stage3c_fixture_cursor_missing");

      const second = await readPage(first.nextCursor);
      expect(second.selectedIds).toEqual(expectedIds.slice(25));
      expect(second.items.map(({ id }) => id)).toEqual(expectedIds.slice(25));
      expect(second.items.length).toBeLessThanOrEqual(25);
      expect(second.nextCursor).toBeUndefined();
      const allIds = [...first.items, ...second.items].map(({ id }) => id);
      expect(allIds).toEqual(expectedIds);
      expect(new Set(allIds).size).toBe(27);
    });

    it.each(hostileIds)("returns no IDs for cursor %s outside the matched set", async (cursor) => {
      const rows = await listActivitiesForContext(trendsContext, prisma, { ...filters, page: historyPageQuery(cursor) });
      expect(rows.map(({ id }) => id)).toEqual([]);
      expect(paginateHistoryItems(rows).items.map(({ id }) => id)).toEqual([]);
    });

    it("returns no IDs for the other household's baby even when explicitly selected", async () => {
      const rows = await listActivitiesForContext(trendsContext, prisma, {
        ...filters, babyId: trendsScope.foreignBabyId, page: historyPageQuery()
      });
      expect(rows.map(({ id }) => id)).toEqual([]);
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an overnight sleep on the day it ended", () => {
  it("appears on both the evening it began and the morning it ended", async () => {
    const sleep = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } }, baby: { connect: { id: babyId } }, actorMember: { connect: { id: memberId } }, type: "sleep",
        occurredAt: overnightStart, startedAt: overnightStart, endedAt: overnightEnd,
        durationSeconds: 42360, timezone: "America/New_York"
      }
    });

    const began = await logIds(sep27);
    const ended = await logIds(sep28);

    expect(began.map((r) => r.id)).toContain(sleep.id);
    // The defect: this list was empty, so the family had to page back a day.
    expect(ended.map((r) => r.id)).toContain(sleep.id);
  });

  it("is anchored to bedtime on the first day and to wake-up on the second", async () => {
    const row = await prisma.activityLog.findFirstOrThrow({ where: { householdId, babyId, type: "sleep" } });

    expect(activityDayAnchor({ startedAt: row.startedAt!, endedAt: row.endedAt }, sep27)).toEqual(overnightStart);
    expect(activityDayAnchor({ startedAt: row.startedAt!, endedAt: row.endedAt }, sep28)).toEqual(overnightEnd);
  });

  it("leaves an ordinary same-day activity on its own day only", async () => {
    const nap = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } }, baby: { connect: { id: babyId } }, actorMember: { connect: { id: memberId } }, type: "sleep",
        occurredAt: new Date("2026-09-28T13:45:00.000Z"),
        startedAt: new Date("2026-09-28T13:45:00.000Z"),
        endedAt: new Date("2026-09-28T16:15:00.000Z"),
        durationSeconds: 9000, timezone: "America/New_York"
      }
    });

    expect((await logIds(sep28)).map((r) => r.id)).toContain(nap.id);
    expect((await logIds(sep27)).map((r) => r.id)).not.toContain(nap.id);
  });

  it("keeps a still-running sleep off the following day", async () => {
    // Started last night, still going: the running timer reports it, the next day's log does not.
    const running = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } }, baby: { connect: { id: babyId } }, actorMember: { connect: { id: memberId } }, type: "sleep",
        occurredAt: overnightStart, startedAt: overnightStart, endedAt: null,
        timerState: "running", durationSeconds: null,
        pauseTrackingStartedAt: overnightStart, pauseTrackingBaselineSeconds: 0,
        timezone: "America/New_York"
      }
    });

    expect((await logIds(sep27)).map((r) => r.id)).toContain(running.id);
    expect((await logIds(sep28)).map((r) => r.id)).not.toContain(running.id);
  });

  it("puts a feed that crosses midnight on both days too", async () => {
    // Not sleep-only: any activity with a real interval can cross midnight.
    const feed = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } }, baby: { connect: { id: babyId } }, actorMember: { connect: { id: memberId } }, type: "feeding",
        occurredAt: new Date("2026-09-28T03:50:00.000Z"), // 11:50pm EDT Sep 27
        startedAt: new Date("2026-09-28T03:50:00.000Z"),
        endedAt: new Date("2026-09-28T04:10:00.000Z"), // 12:10am EDT Sep 28
        durationSeconds: 1200, timezone: "America/New_York"
      }
    });

    expect((await logIds(sep27)).map((r) => r.id)).toContain(feed.id);
    expect((await logIds(sep28)).map((r) => r.id)).toContain(feed.id);
  });

  it("does not show an activity from an unrelated day", async () => {
    const other = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } }, baby: { connect: { id: babyId } }, actorMember: { connect: { id: memberId } }, type: "diaper",
        occurredAt: new Date("2026-09-20T15:00:00.000Z"), startedAt: new Date("2026-09-20T15:00:00.000Z"),
        timezone: "America/New_York"
      }
    });

    expect((await logIds(sep28)).map((r) => r.id)).not.toContain(other.id);
  });
});
