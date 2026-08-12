"use server";

import {
  issueCalendarEventBrowserOperation,
  submitCalendarEventBrowserOperation
} from "@/server/services/calendar";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

type CalendarActionResult =
  | { status: "completed"; operationId: string; eventId: string }
  | { status: "pending"; operationId: string }
  | { status: "stale" | "rejected"; operationId: string };

export async function createCalendarEventAction(formData: FormData): Promise<CalendarActionResult> {
  const input = Object.fromEntries(formData.entries());
  try {
    const issued = await issueCalendarEventBrowserOperation(input);
    if (issued.status !== "pending") return toActionResult(issued);
    return toActionResult(await submitCalendarEventBrowserOperation(input));
  } catch (error) {
    const failure = browserOperationFailureResult(input.operationId, error);
    if (failure) return toActionResult(failure);
    throw error;
  }
}

function toActionResult(result: Awaited<ReturnType<typeof submitCalendarEventBrowserOperation>>): CalendarActionResult {
  if (result.status === "completed") {
    const eventId = typeof result.outcome.eventId === "string" ? result.outcome.eventId : "";
    if (!eventId) return { status: "stale", operationId: result.operationId };
    return { status: "completed", operationId: result.operationId, eventId };
  }
  return result.status === "pending"
    ? { status: "pending", operationId: result.operationId }
    : { status: result.status, operationId: result.operationId };
}
