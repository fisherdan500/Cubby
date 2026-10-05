/**
 * A report must say the same thing after the service stops fetching what it never reads.
 *
 * buildReportStats branches on entry type and reads detail tables off each row. A relation that is
 * not fetched arrives undefined and is SKIPPED rather than throwing, so narrowing the fetch too far
 * would produce quietly smaller numbers with every unit test still green. The only evidence that
 * settles it is the same household read both ways.
 *
 * The comparison is run against the full sixteen-relation shape the service used to request, built
 * here so it cannot drift silently with the production constant.
 */
import { randomBytes } from "node:crypto";
import { ActivityType, DiaperKind, FeedingKind, HouseholdRole, Prisma, TimerState } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const auth = { context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole } };

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: vi.fn(async () => {
    if (!auth.context) throw new Error("context_not_set");
    return auth.context;
  }),
  requirePermission: vi.fn()
}));

import { zonedDateStart } from "@/lib/timezone";
import { prisma } from "@/lib/db/prisma";
import { getReports } from "@/server/services/reports";

const RUN = randomBytes(3).toString("hex");
let userId = "";
let babyId = "";
let householdId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { name: "reports owner", email: `rep-${RUN}@reports.invalid`, emailVerified: true } });
  const household = await prisma.household.create({ data: { name: `Reports ${RUN}`, createdByUserId: user.id } });
  const member = await prisma.householdMember.create({ data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: "owner" } });
  const baby = await prisma.baby.create({ data: { householdId: household.id, name: "Reports Baby", birthDate: new Date("2025-06-01T00:00:00.000Z"), timezone: "America/New_York" } });
  userId = user.id; babyId = baby.id; householdId = household.id;
  auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

  const base = new Date("2026-08-01T08:00:00.000Z").getTime();
  const common = { householdId: household.id, babyId: baby.id, actorMemberId: member.id, timezone: "America/New_York" };
  for (let day = 0; day < 40; day += 1) {
    const at = (h: number) => new Date(base + day * 24 * 3600_000 + h * 3600_000);
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.feeding, occurredAt: at(0), feeding: { create: { mode: FeedingKind.bottle, amount: 120, unit: "mL" } } } });
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.feeding, occurredAt: at(3), feeding: { create: { mode: FeedingKind.breast } } } });
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.diaper, occurredAt: at(5), diaper: { create: { kind: day % 2 ? DiaperKind.wet : DiaperKind.dirty } } } });
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.pumping, occurredAt: at(7), pumping: { create: { amount: 90, unit: "mL" } } } });
    // Kinds the reports do NOT read, because the risk is that dropping a relation changes how an
    // unread entry is counted rather than how a read one is.
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.note, occurredAt: at(9), note: { create: { text: `note ${day}` } } } });
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.bath, occurredAt: at(11), bath: { create: {} } } });
    if (day % 7 === 0) {
      await prisma.activityLog.create({ data: { ...common, type: ActivityType.measurement, occurredAt: at(13), measurement: { create: { weight: new Prisma.Decimal(7 + day * 0.02), weightUnit: "kg", length: new Prisma.Decimal(60 + day * 0.1), lengthUnit: "cm", headCircumference: new Prisma.Decimal(40 + day * 0.05), headUnit: "cm" } } } });
      await prisma.activityLog.create({ data: { ...common, type: ActivityType.milestone, occurredAt: at(15), milestone: { create: { title: `milestone ${day}` } } } });
    }
    const startedAt = at(20);
    const endedAt = new Date(startedAt.getTime() + (8 * 60 + (day % 30)) * 60_000);
    await prisma.activityLog.create({ data: { ...common, type: ActivityType.sleep, occurredAt: startedAt, startedAt, endedAt, durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000), pausedSeconds: 0, timerState: TimerState.stopped, sleep: { create: { sleepType: day % 3 === 0 ? "nap" : "night" } } } });
  }
}, 300_000);

afterAll(async () => { await prisma.$disconnect(); });

describe("a report after the service fetches only what it reads", () => {
  it("reports every entry the full relation set can see", async () => {
    const report = await getReports(userId, { babyId, start: "2026-08-21", end: "2026-09-09", compare: true, history: true });
    expect(report).not.toBeNull();

    // The same window read with EVERY relation - the shape the service used to request. If the
    // narrowed fetch were missing something the statistics read, the report would be built from
    // fewer entries than this read can see.
    // Boundaries computed the way the service computes them, so "the window" means the same thing
    // on both sides of the comparison.
    const windowStart = zonedDateStart("2026-08-21", "America/New_York");
    const windowEnd = zonedDateStart("2026-09-10", "America/New_York");
    const previousStart = zonedDateStart("2026-08-01", "America/New_York");

    const full = await prisma.activityLog.findMany({
      where: { householdId, babyId, deletedAt: null },
      include: {
        actorMember: { include: { user: true } }, baby: true, feeding: true, diaper: true, sleep: true,
        pumping: true, medicine: true, measurement: true, milestone: true, note: true, bath: true,
        play: true, mood: true, supplement: true, vaccine: true, milkInventory: true
      },
      orderBy: { occurredAt: "asc" }
    });

    const inWindow = full.filter((r) => r.occurredAt >= windowStart && r.occurredAt < windowEnd);
    const inPrevious = full.filter((r) => r.occurredAt >= previousStart && r.occurredAt < windowStart);
    const count = (rows: typeof full) => ({
      feeding: rows.filter((r) => r.feeding).length,
      diaper: rows.filter((r) => r.diaper).length,
      sleep: rows.filter((r) => r.sleep).length,
      naps: rows.filter((r) => r.sleep?.sleepType === "nap").length,
      pumping: rows.filter((r) => r.pumping).length,
      measurement: rows.filter((r) => r.measurement).length,
      milestone: rows.filter((r) => r.milestone).length
    });
    const seen = count(inWindow);
    const seenPrevious = count(inPrevious);
    // measurement/milestone are fetched by TWO queries now - the window and the unbounded history -
    // so each needs its own count, or a relation dropped from one include hides behind the other.
    const windowMeasurements = inWindow.filter((r) => r.measurement).length;
    const windowMilestones = inWindow.filter((r) => r.milestone).length;
    // The fixture must actually exercise each one, or the assertions below prove nothing.
    for (const [name, count] of Object.entries(seen)) {
      expect(count, `fixture seeded no ${name}`).toBeGreaterThan(0);
    }

    // Growth is a series per measure, not a flat list. A relation the statistics read but the fetch
    // omits shows up here as an EMPTY series rather than as an error - which is exactly what happens
    // when `measurement` is dropped from the include - so these are the assertions that have teeth.
    const allMeasurements = full.filter((r) => r.measurement).length;
    const allMilestones = full.filter((r) => r.milestone).length;

    // The history query is unbounded, so it must report every measurement the baby has ever had.
    const history = report!.history as {
      growth: { weight: unknown[]; length: unknown[]; head: unknown[] };
      milestones: unknown[];
    };
    expect(history.growth.weight).toHaveLength(allMeasurements);
    expect(history.growth.length).toHaveLength(allMeasurements);
    expect(history.growth.head).toHaveLength(allMeasurements);
    expect(history.milestones).toHaveLength(allMilestones);

    // And the WINDOW's own growth and milestones, which come from the other include entirely.
    const windowStats = report!.stats as typeof stats & {
      growth: { weight: unknown[]; length: unknown[]; head: unknown[] };
      milestones: unknown[];
    };
    expect(windowStats.growth.weight).toHaveLength(windowMeasurements);
    expect(windowStats.milestones).toHaveLength(windowMilestones);
    expect(windowMeasurements, "fixture seeded no measurement inside the window").toBeGreaterThan(0);
    expect(windowMilestones, "fixture seeded no milestone inside the window").toBeGreaterThan(0);

    // Every relation the statistics read must be VISIBLE in the statistics. Dropping one does not
    // throw - the row simply arrives without its detail and is skipped - so each needs an assertion
    // that goes empty when its relation is missing. Proven by mutation: removing `sleep` from the
    // include used to leave this file entirely green.
    const stats = report!.stats as {
      sleep: { totalSeconds: number; naps: number };
      feeding: { count: number };
      diaper: { count: number };
      pumping: { total: number | null };
    };
    // Equality, not merely non-zero: a fetch that returned half the feedings would satisfy
    // "greater than zero" and still be wrong. naps rather than totalSeconds, because totalSeconds
    // reads durationSeconds off the activity row and survives the join being dropped entirely.
    expect(stats.feeding.count).toBe(seen.feeding);
    expect(stats.diaper.count).toBe(seen.diaper);
    expect(stats.sleep.naps).toBe(seen.naps);
    expect(stats.pumping.total ?? 0).toBeGreaterThan(0);
    // The fixture must actually exercise each, or the equalities above are satisfied by zero.
    for (const [name, value] of Object.entries(seen)) {
      expect(value, `fixture seeded no ${name} inside the window`).toBeGreaterThan(0);
    }
    // The comparison window is its own narrowed query, and previously had nothing behind it but a
    // truthiness check that held even when the period was empty.
    const previous = report!.previous as { stats: typeof stats } | null;
    expect(previous).toBeTruthy();
    expect(previous!.stats.feeding.count).toBe(seenPrevious.feeding);
    expect(previous!.stats.diaper.count).toBe(seenPrevious.diaper);
    expect(previous!.stats.sleep.naps).toBe(seenPrevious.naps);
    expect(report!.routine).toBeTruthy();

    // 40 days x (2 feeds + diaper + pumping + note + bath) + 40 sleeps + 6 weeks x (measurement +
    // milestone). Derived rather than guessed, so this asserts the fixture built what it intended.
    expect(full.length).toBe(40 * 6 + 40 + 6 * 2);
    // Both halves must hold data, or the window and comparison equalities above are satisfied by
    // two empty periods agreeing with each other.
    expect(inWindow.length).toBeGreaterThan(0);
    expect(inPrevious.length).toBeGreaterThan(0);
  }, 300_000);
});
