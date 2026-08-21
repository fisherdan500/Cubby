import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCalendarEvent: vi.fn(),
  issueCalendarEventBrowserOperation: vi.fn(),
  submitCalendarEventBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn((operationId: unknown, error: unknown) =>
    error instanceof Error && error.message === "idempotency_conflict"
      ? { status: "rejected", operationId, code: "idempotency_conflict" }
      : null
  )
}));

vi.mock("@/server/services/calendar", () => ({
  createCalendarEvent: mocks.createCalendarEvent,
  issueCalendarEventBrowserOperation: mocks.issueCalendarEventBrowserOperation,
  submitCalendarEventBrowserOperation: mocks.submitCalendarEventBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { createCalendarEventAction, issueCalendarEventAction } from "./actions";

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

  it("opens a server-issued reservation when the client form omits operation ID", async () => {
    const data = form();
    data.delete("operationId");
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    await expect(issueCalendarEventAction(data)).resolves.toEqual({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs" });
    expect(mocks.submitCalendarEventBrowserOperation).not.toHaveBeenCalled();
  });

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

  it("submits a same-ID prepared reservation instead of treating it as a terminal result", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({
      status: "prepared",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "operation_prepared"
    });
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
    expect(mocks.submitCalendarEventBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId: "bmo_0123456789abcdefghjkmnpqrs" }));
  });

  it("reports pending when submit observes an unsubmitted prepared reservation", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    mocks.submitCalendarEventBrowserOperation.mockResolvedValue({
      status: "prepared",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "operation_prepared"
    });

    await expect(createCalendarEventAction(form())).resolves.toEqual({
      status: "pending",
      operationId: "bmo_0123456789abcdefghjkmnpqrs"
    });
  });

  it("preserves every selected contact in the BMO intent and never dual-writes through the legacy creator", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    mocks.submitCalendarEventBrowserOperation.mockResolvedValue({
      status: "completed",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      outcome: { kind: "calendar_event", code: "ok", eventId: "event-1" }
    });
    const data = form();
    data.append("contactIds", "contact-2");
    data.append("contactIds", "contact-1");

    await expect(createCalendarEventAction(data)).resolves.toMatchObject({ status: "completed" });
    expect(mocks.issueCalendarEventBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ contactIds: ["contact-2", "contact-1"] }));
    expect(mocks.submitCalendarEventBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ contactIds: ["contact-2", "contact-1"] }));
    expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
  });

  it("keeps the legacy no-BMO form path as one direct creation", async () => {
    mocks.createCalendarEvent.mockResolvedValue({ id: "event-legacy" });
    const data = form();
    data.delete("operationId");

    await expect(createCalendarEventAction(data)).resolves.toEqual({ status: "completed", operationId: "", eventId: "event-legacy" });
    expect(mocks.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ babyId: "baby-1" }));
    expect(mocks.issueCalendarEventBrowserOperation).not.toHaveBeenCalled();
    expect(mocks.submitCalendarEventBrowserOperation).not.toHaveBeenCalled();
  });

  it("returns only a non-disclosing inline stale/error outcome", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });
    mocks.submitCalendarEventBrowserOperation.mockResolvedValue({ status: "stale", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "stale_target" });

    await expect(createCalendarEventAction(form())).resolves.toEqual({ status: "stale", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "stale_target" });
  });

  it("returns an explicit expired result without submitting a compacted operation", async () => {
    mocks.issueCalendarEventBrowserOperation.mockResolvedValue({
      status: "expired",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "operation_result_expired"
    });

    await expect(createCalendarEventAction(form())).resolves.toEqual({
      status: "expired",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "operation_result_expired"
    });
    expect(mocks.submitCalendarEventBrowserOperation).not.toHaveBeenCalled();
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
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      code: "idempotency_conflict"
    });
    expect(mocks.submitCalendarEventBrowserOperation).not.toHaveBeenCalled();
  });
});
