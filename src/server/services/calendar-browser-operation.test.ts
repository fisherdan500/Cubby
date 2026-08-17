import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getBabyContext: vi.fn(),
  issueBrowser: vi.fn(),
  executeBrowser: vi.fn(),
  contactFindMany: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForBaby: mocks.getBabyContext,
  issueBrowserOperation: mocks.issueBrowser,
  executeBrowserOperation: mocks.executeBrowser
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { contact: { findMany: mocks.contactFindMany } } }));
vi.mock("@/lib/env", () => ({
  env: { APP_TIMEZONE: "America/New_York", BETTER_AUTH_URL: "http://127.0.0.1:3999" },
  trustedOrigins: () => []
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import { issueCalendarEventBrowserOperation } from "./calendar";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "parent" as const };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBabyContext.mockResolvedValue(ctx);
  mocks.issueBrowser.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.contactFindMany.mockResolvedValue([
    { id: "contact-1", updatedAt: new Date("2026-08-20T10:00:00.000Z") },
    { id: "contact-2", updatedAt: new Date("2026-08-21T10:00:00.000Z") }
  ]);
});

describe("calendar event browser-v2 opening", () => {
  it("freezes the selected baby, sorted contact revisions, and member episode before editable event submission", async () => {
    await expect(issueCalendarEventBrowserOperation({
      operationId,
      babyId: "baby-1",
      contactIds: ["contact-2", "contact-1"]
    })).resolves.toMatchObject({ status: "open", operationId });

    const input = mocks.issueBrowser.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      babyId: "baby-1",
      targetKind: "calendar",
      permission: "activity.create",
      opening: { babyId: "baby-1", contactIds: ["contact-1", "contact-2"] }
    });
    expect(input.targetSnapshot).toBeTypeOf("function");
    await expect(input.targetSnapshot({
      $queryRaw: vi.fn(),
      contact: { findMany: mocks.contactFindMany }
    } as never, ctx, {
      id: "baby-1", updatedAt: new Date("2026-08-19T10:00:00.000Z"), inactiveAt: null
    })).resolves.toEqual({
      kind: "calendar-event-create",
      schemaVersion: 1,
      baby: { id: "baby-1", revision: "2026-08-19T10:00:00.000Z" },
      contacts: [
        { id: "contact-1", revision: "2026-08-20T10:00:00.000Z" },
        { id: "contact-2", revision: "2026-08-21T10:00:00.000Z" }
      ]
    });
  });
});
