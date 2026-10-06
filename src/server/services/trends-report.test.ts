// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { activityLog: { findMany: mocks.findMany } } }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

beforeEach(() => {
  vi.resetModules();
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.getEffectiveHouseholdContext.mockReset().mockResolvedValue({ householdId: "household-1", role: "parent" });
  mocks.requirePermission.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function readTrends(window: "8w" | "6m" | "all" = "6m") {
  const { getTrends } = await import("@/server/services/trends-report");
  await getTrends("baby-1", window);
  return mocks.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };
}

describe("the trends query", () => {
  it.each(["8w", "all"] as const)("rejects old duration-only sleeps returned outside the resolved %s window", async (window) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    mocks.findMany.mockResolvedValue([1, 2, 3].map((day) => ({
      type: "sleep",
      occurredAt: new Date(`2020-06-0${day}T12:00:00Z`),
      startedAt: null,
      endedAt: null,
      durationSeconds: 3600,
      timerState: "none",
      pausedAt: null,
      pausedSeconds: null,
      pauseTrackingStartedAt: null,
      pauseTrackingBaselineSeconds: null,
      pauseIntervals: [],
      feeding: null,
      diaper: null
    })));
    const { getTrends } = await import("@/server/services/trends-report");

    const result = await getTrends("baby-1", window);

    expect(result.anyData).toBe(false);
    expect(result).toMatchObject({ startKey: "", endKey: "", weeks: 0 });
    for (const key of ["sleep", "daytimeSleep", "nighttimeSleep", "feeds", "volume", "diapers", "wetDiapers", "dirtyDiapers"] as const) {
      expect(result[key]).toEqual({ points: [], daysCounted: 0 });
    }
  });

  it("selects only diaper kind and carries it through getTrends to the builder", async () => {
    const kinds = ["wet", "dirty", "mixed", "dry", null];
    mocks.findMany.mockResolvedValue(kinds.map((kind) => ({
      type: "diaper",
      occurredAt: new Date("2026-06-01T12:00:00Z"),
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      timerState: "none",
      pausedAt: null,
      pausedSeconds: null,
      pauseTrackingStartedAt: null,
      pauseTrackingBaselineSeconds: null,
      pauseIntervals: [],
      feeding: null,
      diaper: kind === null ? null : { kind }
    })));
    const service = await import("@/server/services/trends");
    const builder = vi.spyOn(service, "buildTrends");

    const query = await readTrends();

    expect(query.select).toEqual({
      type: true,
      occurredAt: true,
      startedAt: true,
      endedAt: true,
      durationSeconds: true,
      timerState: true,
      pausedAt: true,
      pausedSeconds: true,
      pauseTrackingStartedAt: true,
      pauseTrackingBaselineSeconds: true,
      pauseIntervals: { select: { startedAt: true, endedAt: true } },
      feeding: { select: { amount: true, mode: true, unit: true } },
      diaper: { select: { kind: true } }
    });
    expect(builder).toHaveBeenCalledOnce();
    expect(builder.mock.calls[0][0].map((activity) => activity.diaperKind)).toEqual(kinds);
  });

  it("asks only for this household's own baby, and only for what a trend needs", async () => {
    const query = await readTrends();

    expect(query.where).toMatchObject({ householdId: "household-1", babyId: "baby-1", deletedAt: null });
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "activity.read");
  });

  it("bounds only unfinished sleep candidates by the two-day policy with canonical start fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const query = await readTrends("8w");
    const branches = query.where.OR as Array<Record<string, unknown>>;
    const sleepBranch = branches.find((branch) => branch.type === "sleep");
    const from = new Date("2026-04-16T00:00:00Z");
    const earliestStart = new Date("2026-04-14T00:00:00Z");

    expect(query.where).toMatchObject({ householdId: "household-1", babyId: "baby-1", deletedAt: null });
    expect(sleepBranch).toEqual({
      type: "sleep",
      occurredAt: { lt: new Date("2026-06-11T00:00:00Z") },
      OR: [
        // A genuinely long finished sleep may overlap, with no lower start bound.
        { endedAt: { gt: from } },
        {
          endedAt: null,
          OR: [
            { startedAt: { gt: earliestStart } },
            { startedAt: null, occurredAt: { gt: earliestStart } }
          ]
        }
      ]
    });
  });

  it("asks feeds and changes for the window itself, since they happen at an instant", async () => {
    const query = await readTrends();
    const branches = query.where.OR as Array<Record<string, unknown>>;
    const instantBranch = branches.find((branch) => Array.isArray((branch.type as { in?: string[] })?.in));

    expect((instantBranch?.type as { in: string[] }).in).toEqual(["feeding", "diaper"]);
    expect(instantBranch?.occurredAt).toMatchObject({ gte: expect.any(Date), lt: expect.any(Date) });
  });

  it("reads the amount's own unit, so millilitres are not added to ounces", async () => {
    const query = await readTrends();
    const feeding = query.select.feeding as { select: Record<string, boolean> };

    expect(feeding.select).toMatchObject({ amount: true, mode: true, unit: true });
  });

  it("bounds even the longest window rather than reading everything ever logged", async () => {
    const query = await readTrends("all");
    const branches = query.where.OR as Array<Record<string, unknown>>;
    const instantBranch = branches.find((branch) => Array.isArray((branch.type as { in?: string[] })?.in));
    const from = (instantBranch?.occurredAt as { gte: Date }).gte;

    // Two years: a weekly chart of a hundred-odd points is already more than can be read at once,
    // and placing every entry in the household's zone is what makes this page slow.
    const yearsBack = (Date.now() - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
    expect(yearsBack).toBeLessThanOrEqual(2.1);
    expect(yearsBack).toBeGreaterThan(1.9);
  });
  it("carries each amount's own unit through to the chart, not just into the query", () => {
    // Asking the database for the unit is not the same as using it. Proving the SELECT contains it
    // left room for the value to be dropped on the way to the builder, reverting the fix unseen.
    // Keep the fixture and application timezone on the same day, independently of the host timezone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T08:00:00.000Z"));
    return (async () => {
      const day = 24 * 60 * 60 * 1000;
      const rows = [];
      for (let index = 1; index <= 21; index += 1) {
        const occurredAt = new Date(Date.now() - index * day);
        for (let n = 0; n < 8; n += 1) {
          rows.push({
            type: "feeding",
            occurredAt: new Date(occurredAt.getTime() + n * 60 * 60 * 1000),
            startedAt: null,
            endedAt: null,
            durationSeconds: null,
            timerState: "none",
            pausedAt: null,
            pausedSeconds: null,
            pauseTrackingStartedAt: null,
            pauseTrackingBaselineSeconds: null,
            pauseIntervals: [],
            // 118.294 mL is 4 oz. Read raw, it would read as 118.
            feeding: { amount: 118.294, mode: "bottle", unit: "mL" }
          });
        }
      }
      mocks.findMany.mockResolvedValue(rows);

      const { getTrends } = await import("@/server/services/trends-report");
      const trends = await getTrends("baby-1", "8w");
      const reported = trends.volume.points.filter((point) => point.value !== null);

      expect(reported.length).toBeGreaterThan(0);
      for (const point of reported) expect(point.value).toBeCloseTo(32, 0);
    })();
  });
});
