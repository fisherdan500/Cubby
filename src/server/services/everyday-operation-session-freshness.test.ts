import { describe, expect, it, vi } from "vitest";

/**
 * Regression: every browser-operation-backed mutation (logging a feeding, running a timer, adding a
 * calendar event, changing household preferences) used to demand a sign-in inside the last ten
 * minutes, so ordinary use failed with fresh_authentication_required. Sensitive operations must keep
 * enforcing freshness at their own call sites.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  babyFindFirst: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { session: { findFirst: vi.fn() }, baby: { findFirst: mocks.babyFindFirst }, householdMember: { findFirst: vi.fn() }, $transaction: vi.fn() }
}));
vi.mock("@/server/services/global-session-security", () => ({ recordQualifyingGlobalSessionUseAfterSuccess: vi.fn() }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBrowserOperationContextForBaby, getBrowserOperationContextForHousehold } from "@/server/services/browser-operations";

const dayOldSession = {
  user: { id: "user-1" },
  session: { id: "session-1", createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
};
const ctx = { userId: "user-1", householdId: "household-1", memberId: "member-1", role: "parent" as const };

describe("everyday operations and session freshness", () => {
  it("opens a baby-scoped context on a day-old session", async () => {
    mocks.getSession.mockResolvedValue(dayOldSession);
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
    mocks.babyFindFirst.mockResolvedValue({ id: "baby-1" });

    await expect(getBrowserOperationContextForBaby("baby-1")).resolves.toMatchObject({ ...ctx, sessionId: "session-1" });
  });

  it("opens a household-scoped context on a day-old session", async () => {
    mocks.getSession.mockResolvedValue(dayOldSession);
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);

    await expect(getBrowserOperationContextForHousehold()).resolves.toMatchObject({ ...ctx, sessionId: "session-1" });
  });

  it("still rejects a signed-out caller and a session belonging to another user", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(getBrowserOperationContextForHousehold()).rejects.toThrow("unauthenticated");

    mocks.getSession.mockResolvedValue({ user: { id: "someone-else" }, session: { id: "session-9" } });
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
    await expect(getBrowserOperationContextForHousehold()).rejects.toThrow("forbidden");
  });

  it("keeps freshness where the operation is sensitive", () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
    // Credentials, API keys, admin invites and leaving a household re-check at their own call sites.
    expect(read("src/server/services/integrations.ts")).toContain("requireFreshSession");
    expect(read("src/server/services/invites.ts")).toContain("requireFreshSession");
    expect(read("src/server/services/household-leave.ts")).toContain("requireFreshSession");
    expect(read("src/server/services/browser-operation-status.ts")).toContain("assertFreshSession(authSession)");
    // ...and the everyday context must not reintroduce a blanket check.
    expect(read("src/server/services/browser-operations.ts")).not.toContain("requireFreshSession");
  });
});
