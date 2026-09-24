import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readHouseholdMemberCandidate: vi.fn(),
  getHouseholdHome: vi.fn(),
  findMany: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({ readHouseholdMemberCandidate: mocks.readHouseholdMemberCandidate }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { activityLog: { findMany: mocks.findMany } } }));

import { getActiveTimersForShell } from "@/server/services/active-timers";

const home = {
  householdId: "household-1",
  household: {
    babies: [
      { id: "baby-a", name: "Avery", inactiveAt: null },
      { id: "baby-b", name: "Blake", inactiveAt: null },
      { id: "baby-inactive", name: "Casey", inactiveAt: new Date("2026-09-20T00:00:00.000Z") }
    ]
  }
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readHouseholdMemberCandidate.mockReturnValue({ status: "present" });
  mocks.getHouseholdHome.mockResolvedValue(home);
  mocks.findMany.mockResolvedValue([
    {
      id: "timer-a",
      type: "sleep",
      babyId: "baby-a",
      timerState: "running",
      startedAt: new Date("2026-09-22T12:00:00.000Z"),
      pausedAt: null,
      pausedSeconds: 0
    },
    {
      id: "timer-b",
      type: "feeding",
      babyId: "baby-b",
      timerState: "paused",
      startedAt: new Date("2026-09-22T11:00:00.000Z"),
      pausedAt: new Date("2026-09-22T11:30:00.000Z"),
      pausedSeconds: 0
    }
  ]);
});

function timerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "timer-a",
    type: "sleep",
    babyId: "baby-a",
    timerState: "running",
    startedAt: new Date("2026-09-22T12:00:00.000Z"),
    pausedAt: null,
    pausedSeconds: 0,
    ...overrides
  };
}

describe("active timers for the application shell", () => {
  it("returns every active baby's labeled timers when the page has no selected baby", async () => {
    const timers = await getActiveTimersForShell();

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ babyId: { in: ["baby-a", "baby-b"] } })
    }));
    expect(timers.map((timer) => [timer.id, timer.babyName])).toEqual([
      ["timer-a", "Avery"],
      ["timer-b", "Blake"]
    ]);
  });

  it("disambiguates timers owned by babies with the same display name", async () => {
    mocks.getHouseholdHome.mockResolvedValue({
      household: {
        babies: [
          { id: "baby-a", name: "Avery", inactiveAt: null },
          { id: "baby-b", name: "Avery", inactiveAt: null }
        ]
      }
    });
    mocks.findMany.mockResolvedValue([
      timerRow({ id: "timer-a", babyId: "baby-a" }),
      timerRow({ id: "timer-b", babyId: "baby-b" })
    ]);

    const result = await getActiveTimersForShell();

    expect(result.map((timer) => timer.babyName)).toEqual([
      "Avery (baby 1 of 2)",
      "Avery (baby 2 of 2)"
    ]);
  });

  it("limits the shell query to the explicitly selected active baby", async () => {
    mocks.findMany.mockResolvedValueOnce([
      {
        id: "timer-b",
        type: "feeding",
        babyId: "baby-b",
        timerState: "paused",
        startedAt: new Date("2026-09-22T11:00:00.000Z"),
        pausedAt: new Date("2026-09-22T11:30:00.000Z"),
        pausedSeconds: 0
      }
    ]);

    const timers = await getActiveTimersForShell("baby-b");

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ babyId: "baby-b" })
    }));
    expect(timers).toEqual([
      expect.objectContaining({ id: "timer-b", babyId: "baby-b", babyName: "Blake" })
    ]);
  });

  it.each(["", "baby-inactive", "foreign-baby", "not/a/valid-id"])(
    "does not broaden an invalid selected baby to all babies: %s",
    async (babyId) => {
      const timers = await getActiveTimersForShell(babyId);

      expect(timers).toEqual([]);
      expect(mocks.findMany).not.toHaveBeenCalled();
    }
  );
});
