// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { activityLog: { findMany: mocks.findMany } } }));
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

async function readTrends(window: "8w" | "6m" | "all" = "6m") {
  const { getTrends } = await import("@/server/services/trends-report");
  await getTrends("baby-1", window);
  return mocks.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };
}

describe("the trends query", () => {
  it("asks only for this household's own baby, and only for what a trend needs", async () => {
    const query = await readTrends();

    expect(query.where).toMatchObject({ householdId: "household-1", babyId: "baby-1", deletedAt: null });
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "activity.read");
  });

  it("selects a sleep that OVERLAPS the window, however long before it began", async () => {
    // A fixed lookback is arbitrary: a timer somebody left running for days would silently lose
    // whatever fell outside it, and the first morning of the window would read as a false low. This
    // is the rule the dashboard already uses, which the service claims to mirror.
    const query = await readTrends();
    const branches = query.where.OR as Array<Record<string, unknown>>;
    const sleepBranch = branches.find((branch) => branch.type === "sleep");

    expect(sleepBranch).toBeDefined();
    // No lower bound on when it started - only that it had not finished before the window opened.
    expect(sleepBranch?.occurredAt).not.toHaveProperty("gte");
    expect(sleepBranch?.OR).toEqual([{ endedAt: { gt: expect.any(Date) } }, { endedAt: null }]);
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
});
