import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueCalendarEventBrowserOperation: vi.fn(),
  submitCalendarEventBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn((operationId: unknown, error: unknown) =>
    error instanceof Error && error.message === "idempotency_conflict"
      ? { status: "rejected", operationId, code: "idempotency_conflict" }
      : null
  )
}));

vi.mock("@/server/services/calendar", () => ({
  issueCalendarEventBrowserOperation: mocks.issueCalendarEventBrowserOperation,
  submitCalendarEventBrowserOperation: mocks.submitCalendarEventBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { createCalendarEventAction } from "./actions";

function form() {
  const data = new FormData();
  data.set("operationId", "bmo_0123456789abcdefghjkmnpqrs");
  data.set("babyId", "baby-1");
  data.set("title", "Checkup");
  data.set("startDate", "2026-08-12");
  data.set("startTime", "09:00");
  return data;
}

describe("createCalendarEventAction", () => {
  beforeEach(() => vi.resetAllMocks());

  it("issues and submits the same client-created operation ID without redirecting", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    mocks.submitCalendarEventBrowserOperation.mockResolvedValue({
      status: "completed",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      outcome: { kind: "calendar_event", code: "ok", eventId: "event-1" }
    });

    await expect(createCalendarEventAction(form())).resolves.toEqual({
      status: "completed",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      eventId: "event-1"
    });
    expect(mocks.issueCalendarEventBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId: "bmo_0123456789abcdefghjkmnpqrs" }));
    expect(mocks.submitCalendarEventBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId: "bmo_0123456789abcdefghjkmnpqrs" }));
  });

  it("returns only a non-disclosing inline stale/error outcome", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    mocks.submitCalendarEventBrowserOperation.mockResolvedValue({ status: "stale", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "stale_target" });

    await expect(createCalendarEventAction(form())).resolves.toEqual({ status: "stale", operationId: "bmo_0123456789abcdefghjkmnpqrs" });
  });

  it("maps an expected operation conflict to a non-disclosing rejected result", async () => {
    mocks.issueCalendarEventBrowserOperation.mockRejectedValue(new Error("idempotency_conflict"));
    mocks.browserOperationFailureResult.mockReturnValue({
      status: "rejected",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "idempotency_conflict"
    });

    await expect(createCalendarEventAction(form())).resolves.toEqual({
      status: "rejected",
      operationId: "bmo_0123456789abcdefghjkmnpqrs"
    });
    expect(mocks.submitCalendarEventBrowserOperation).not.toHaveBeenCalled();
  });
});
