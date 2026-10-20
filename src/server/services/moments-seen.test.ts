import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  markerFindUnique: vi.fn(),
  markerUpsert: vi.fn(),
  postCount: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    momentsSeenMarker: { findUnique: mocks.markerFindUnique, upsert: mocks.markerUpsert },
    feedPost: { count: mocks.postCount }
  }
}));

import { countUnseenMoments, markMomentsSeen } from "@/server/services/moments-seen";

const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "caretaker" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.postCount.mockResolvedValue(0);
});

describe("the unseen-moments badge", () => {
  it("counts posts newer than the marker, in this household, excluding this member's own", async () => {
    mocks.markerFindUnique.mockResolvedValue({ seenAt: new Date("2026-10-19T12:00:00Z") });
    mocks.postCount.mockResolvedValue(3);

    expect(await countUnseenMoments()).toBe(3);

    // Every term matters: household from the CONTEXT, removed posts invisible, created after the
    // marker, and never the member's own posts - they were looking at the screen when they posted.
    expect(mocks.postCount.mock.calls[0][0].where).toEqual({
      householdId: ctx.householdId,
      deletedAt: null,
      createdAt: { gt: new Date("2026-10-19T12:00:00Z") },
      NOT: { authorMemberId: ctx.memberId }
    });
  });

  it("answers zero for a member who has never opened Moments, without counting anything", async () => {
    // Badging a brand-new member with the household's whole history is noise; the first visit
    // writes the marker and starts the clock.
    mocks.markerFindUnique.mockResolvedValue(null);

    expect(await countUnseenMoments()).toBe(0);
    expect(mocks.postCount).not.toHaveBeenCalled();
  });

  it("reads the marker for exactly this member in this household", async () => {
    mocks.markerFindUnique.mockResolvedValue(null);
    await countUnseenMoments();
    expect(mocks.markerFindUnique.mock.calls[0][0].where).toEqual({
      householdId_memberId: { householdId: ctx.householdId, memberId: ctx.memberId }
    });
  });
});

describe("marking Moments seen", () => {
  it("moves this member's marker to now, one row per member", async () => {
    await markMomentsSeen();

    const call = mocks.markerUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ householdId_memberId: { householdId: ctx.householdId, memberId: ctx.memberId } });
    expect(call.create.householdId).toBe(ctx.householdId);
    expect(call.create.memberId).toBe(ctx.memberId);
    expect(call.create.seenAt).toBeInstanceOf(Date);
    expect(call.update.seenAt).toBeInstanceOf(Date);
  });

  it("requires the same read permission the feed itself requires", async () => {
    await markMomentsSeen();
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "activity.read");
  });
});
