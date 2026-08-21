"use server";

import {
  createCalendarEvent,
  issueCalendarEventBrowserOperation,
  submitCalendarEventBrowserOperation
} from "@/server/services/calendar";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

type CalendarActionResult =
  | { status: "completed"; operationId: string; eventId: string }
  | { status: "pending"; operationId: string }
  | { status: "stale" | "rejected"; operationId: string; code: string }
  | { status: "expired"; operationId: string; code: "operation_abandoned" | "operation_result_expired" };

export async function issueCalendarEventAction(formData: FormData): Promise<{ status: string; operationId: string }> {
  const input = calendarFormInput(formData);
  const result = await issueCalendarEventBrowserOperation(input);
  return { status: result.status, operationId: result.operationId };
}

export async function createCalendarEventAction(formData: FormData): Promise<CalendarActionResult> {
  const input = calendarFormInput(formData);
  if (!input.operationId) {
    const event = await createCalendarEvent(input);
    return { status: "completed", operationId: "", eventId: event.id };
  }
  try {
    const issued = await issueCalendarEventBrowserOperation(input);
    if (issued.status === "open" || issued.status === "prepared") {
      const submitted = await submitCalendarEventBrowserOperation(input);
      return submitted.status === "open" || submitted.status === "prepared"
        ? { status: "pending", operationId: submitted.operationId }
        : toActionResult(submitted);
    }
    return toActionResult(issued);
  } catch (error) {
    const failure = browserOperationFailureResult(input.operationId, error);
    if (failure) {
      return failure.status === "open"
        ? { status: "stale", operationId: failure.operationId, code: "stale_context" }
        : toActionResult(failure);
    }
    throw error;
  }
}

function calendarFormInput(formData: FormData) {
  return {
    ...Object.fromEntries(formData.entries()),
    operationId: formData.get("operationId") ?? undefined,
    contactIds: formData.getAll("contactIds").filter((value): value is string => typeof value === "string")
  };
}

function toActionResult(result: Exclude<Awaited<ReturnType<typeof submitCalendarEventBrowserOperation>>, { status: "open" | "prepared" }>): CalendarActionResult {
  if (result.status === "completed") {
    const eventId = typeof result.outcome.eventId === "string" ? result.outcome.eventId : "";
    if (!eventId) return { status: "stale", operationId: result.operationId, code: "operation_integrity_error" };
    return { status: "completed", operationId: result.operationId, eventId };
  }
  if (result.status === "pending") return { status: "pending", operationId: result.operationId };
  if (result.status === "expired") {
    if (result.code === "operation_abandoned" || result.code === "operation_result_expired") {
      return { status: "expired", operationId: result.operationId, code: result.code };
    }
    return { status: "stale", operationId: result.operationId, code: "operation_integrity_error" };
  }
  return { status: result.status, operationId: result.operationId, code: result.code };
}
