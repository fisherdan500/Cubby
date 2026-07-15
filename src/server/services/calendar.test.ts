import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  babyFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  rowLock: vi.fn(),
  calendarCreate: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    baby: { findFirst: mocks.babyFindFirst },
    calendarEvent: { create: mocks.calendarCreate },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/lib/env", () => ({
  env: {
    APP_TIMEZONE: "America/New_York",
    BETTER_AUTH_URL: "http://127.0.0.1:3999"
  },
  trustedOrigins: () => []
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { createCalendarEvent } from "@/server/services/calendar";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdContext.mockResolvedValue({
    userId: "user-1",
    householdId: "household-1",
    memberId: "member-1",
    role: "parent"
  });
  mocks.babyFindFirst.mockResolvedValue({
    id: "baby-1",
    inactiveAt: new Date("2026-07-14T12:00:00.000Z")
  });
  mocks.memberFindUnique.mockResolvedValue({
    id: "member-1",
    householdId: "household-1",
    role: "parent",
    disabledAt: null,
    deletedAt: null
  });
  mocks.rowLock.mockResolvedValue([{ id: "locked" }]);
  mocks.calendarCreate.mockResolvedValue({
    id: "event-1",
    title: "Appointment",
    startTime: new Date("2026-07-15T13:00:00.000Z"),
    endTime: null,
    babies: []
  });
  mocks.transaction.mockImplementation((operation) =>
    operation({
      $queryRaw: mocks.rowLock,
      householdMember: { findUnique: mocks.memberFindUnique },
      baby: { findFirst: mocks.babyFindFirst },
      calendarEvent: { create: mocks.calendarCreate }
    })
  );
});

describe("calendar event lifecycle gates", () => {
  it("rejects new events for an inactive baby", async () => {
    await expect(
      createCalendarEvent({
        babyId: "baby-1",
        title: "Appointment",
        startDate: "2026-07-15",
        startTime: "09:00"
      })
    ).rejects.toThrow("baby_inactive");

    expect(mocks.calendarCreate).not.toHaveBeenCalled();
  });
});
