import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  transaction: vi.fn(),
  lockActorForWrite: vi.fn(),
  listActivities: vi.fn(),
  listActivitiesForContext: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/server/services/mutation-locks", () => ({ lockActorForWrite: mocks.lockActorForWrite }));
vi.mock("@/server/services/activities", () => ({
  listActivities: mocks.listActivities,
  listActivitiesForContext: mocks.listActivitiesForContext
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { activityCsv, activitySpreadsheet } from "@/server/services/export";

const ownerContext = { userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner" };

function exportedActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    baby: { name: "Avery", inactiveAt: null },
    type: "feeding",
    occurredAt: new Date("2026-09-19T14:30:00.000Z"),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timezone: "America/New_York",
    actorMember: { displayName: "Dad", user: { name: "Daniel" } },
    notes: null,
    feeding: { mode: "bottle", amount: 4, unit: "oz" },
    ...overrides
  };
}

describe("activity export audit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ownerContext);
    mocks.requirePermission.mockImplementation((context) => {
      if (context.role !== "owner") throw new Error("forbidden");
    });
    mocks.transaction.mockImplementation(async (callback) => callback({ activityLog: { findMany: vi.fn() } }));
    mocks.lockActorForWrite.mockImplementation(async (_tx, context) => context);
    mocks.listActivities.mockResolvedValue([]);
    mocks.listActivitiesForContext.mockResolvedValue([]);
  });

  it("rechecks export authority inside one transaction before reading or auditing export data", async () => {
    mocks.lockActorForWrite.mockResolvedValue({ ...ownerContext, role: "read_only" });

    await expect(activityCsv()).rejects.toThrow("forbidden");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.listActivitiesForContext).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("rechecks export authority for the spreadsheet too", async () => {
    mocks.lockActorForWrite.mockResolvedValue({ ...ownerContext, role: "read_only" });

    await expect(activitySpreadsheet()).rejects.toThrow("forbidden");

    expect(mocks.listActivitiesForContext).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("records one export audit event per download", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([exportedActivity()]);

    await activityCsv();
    await activitySpreadsheet();

    expect(mocks.writeAudit).toHaveBeenCalledTimes(2);
    expect(mocks.writeAudit.mock.calls[0][1]).toMatchObject({ action: "export.csv", entityType: "household", entityId: "household-1" });
  });
});

describe("activity export contents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ownerContext);
    mocks.requirePermission.mockImplementation((context) => {
      if (context.role !== "owner") throw new Error("forbidden");
    });
    mocks.transaction.mockImplementation(async (callback) => callback({ activityLog: { findMany: vi.fn() } }));
    mocks.lockActorForWrite.mockImplementation(async (_tx, context) => context);
    mocks.listActivitiesForContext.mockResolvedValue([exportedActivity()]);
  });

  it("writes one header row and one row per activity, with the recorded values", async () => {
    const [header, row, ...rest] = (await activityCsv()).split("\n");

    expect(header).toBe('"id","baby","type","occurredAt","startedAt","endedAt","durationSeconds","timezone","actor","details","notes"');
    expect(row).toBe('"activity-1","Avery","feeding","2026-09-19T14:30:00.000Z","","","","America/New_York","Dad","Kind: Bottle; Amount: 4 oz",""');
    expect(rest).toEqual([]);
  });

  it("carries the saved fields the dashboard summary leaves out", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([
      exportedActivity({
        feeding: { mode: "breast", side: "left", leftSeconds: 300, rightSeconds: 240 }
      })
    ]);

    // Nursing per-side times were stored and shown in the app, but an export dropped them, because the
    // details column reused the terse one-line summary a list row shows.
    expect(await activityCsv()).toContain('"Kind: Breast; Side: Left; Left side: 5 min; Right side: 4 min"');
  });

  it("carries a vaccine's lot and due date, which an export used to lose", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([
      exportedActivity({
        type: "vaccine",
        feeding: null,
        vaccine: { name: "DTaP", dose: "1 of 5", lot: "A123", provider: "Dr. Lee", dueDate: new Date("2026-10-01T00:00:00.000Z") }
      })
    ]);

    const csv = await activityCsv();
    expect(csv).toContain("Lot: A123");
    expect(csv).toContain("Due date: Oct 1, 2026");
  });

  it("marks an inactive baby so a restored export is not misread", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([
      exportedActivity({ baby: { name: "Avery", inactiveAt: new Date("2026-09-01T00:00:00.000Z") } })
    ]);

    expect(await activityCsv()).toContain('"Avery (Inactive)"');
  });

  it("escapes quotes and keeps commas inside one CSV field", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([
      exportedActivity({ notes: 'She said "more", then slept' })
    ]);
    const [, row] = (await activityCsv()).split("\n");

    expect(row.endsWith('"She said ""more"", then slept"')).toBe(true);
  });

  it("keeps a note's line breaks in the CSV field, where quoting carries them", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([exportedActivity({ notes: "first line\nsecond line" })]);

    expect(await activityCsv()).toContain('"first line\nsecond line"');
  });

  it("keeps every spreadsheet row on one line, even when a note contains line breaks", async () => {
    // The tab-separated export used to be produced by re-parsing the finished CSV line by line, so a
    // note with a line break became extra rows and shifted every column after it.
    mocks.listActivitiesForContext.mockResolvedValue([
      exportedActivity({ notes: "first line\nsecond line" }),
      exportedActivity({ id: "activity-2", notes: "plain" })
    ]);
    const lines = (await activitySpreadsheet()).split("\n");

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.split("\t")).toHaveLength(11);
    expect(lines[1].split("\t")[10]).toBe("first line second line");
    expect(lines[2].split("\t")[0]).toBe("activity-2");
  });

  it("does not let a tab inside a value split a spreadsheet column", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([exportedActivity({ notes: "before\tafter" })]);
    const [, row] = (await activitySpreadsheet()).split("\n");

    expect(row.split("\t")).toHaveLength(11);
    expect(row.split("\t")[10]).toBe("before after");
  });

  it("exports only the header when the household has no activity", async () => {
    mocks.listActivitiesForContext.mockResolvedValue([]);

    expect((await activityCsv()).split("\n")).toHaveLength(1);
    expect((await activitySpreadsheet()).split("\n")).toHaveLength(1);
  });
});
