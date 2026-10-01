/**
 * An overnight sleep on both days, against real PostgreSQL.
 *
 * The unit tests pin the rule; this proves the query actually returns the sleep on the morning the
 * family woke up, with real rows and a real day window. The defect it guards was invisible to every
 * unit test because the query itself was what filtered the sleep away.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activityDayAnchor } from "@/domain/activity";
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
