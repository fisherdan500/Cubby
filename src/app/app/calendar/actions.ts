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
  | { status: "stale" | "rejected"; operationId: string };

export async function createCalendarEventAction(formData: FormData): Promise<CalendarActionResult> {
  const input = calendarFormInput(formData);
  if (!input.operationId) {
    const event = await createCalendarEvent(input);
    return { status: "completed", operationId: "", eventId: event.id };
  }
  try {
    const issued = await issueCalendarEventBrowserOperation(input);
    if (issued.status === "open") {
      const submitted = await submitCalendarEventBrowserOperation(input);
      return submitted.status === "open"
        ? { status: "stale", operationId: submitted.operationId }
        : toActionResult(submitted);
    }
    return toActionResult(issued);
  } catch (error) {
    const failure = browserOperationFailureResult(input.operationId, error);
    if (failure) {
      return failure.status === "open"
        ? { status: "stale", operationId: failure.operationId }
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

function toActionResult(result: Exclude<Awaited<ReturnType<typeof submitCalendarEventBrowserOperation>>, { status: "open" }>): CalendarActionResult {
  if (result.status === "completed") {
    const eventId = typeof result.outcome.eventId === "string" ? result.outcome.eventId : "";
    if (!eventId) return { status: "stale", operationId: result.operationId };
    return { status: "completed", operationId: result.operationId, eventId };
  }
  if (result.status === "pending") return { status: "pending", operationId: result.operationId };
  return { status: result.status === "expired" ? "stale" : result.status, operationId: result.operationId };
}
