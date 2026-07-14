"use server";

import { redirect } from "next/navigation";
import { createCalendarEvent } from "@/server/services/calendar";

export async function createCalendarEventAction(formData: FormData) {
  const input = Object.fromEntries(formData.entries());
  const opener = validCalendarOpener(String(input.opener ?? ""));
  const fallback = calendarUrl({
    babyId: String(input.babyId ?? ""),
    month: String(input.month ?? String(input.startDate ?? "").slice(0, 7)),
    date: String(input.startDate ?? ""),
    opener
  });

  let target = fallback;
  try {
    const event = await createCalendarEvent(input);
    target = calendarUrl({
      babyId: event.babyId,
      month: event.month,
      date: event.date,
      eventId: event.id,
      opener
    });
  } catch (error) {
    target = `${fallback}&new=1&error=${encodeURIComponent(calendarErrorMessage(error))}`;
  }

  redirect(target);
}

function calendarUrl(input: { babyId: string; month: string; date?: string; eventId?: string; opener?: string }) {
  const params = new URLSearchParams();
  if (input.babyId) params.set("babyId", input.babyId);
  if (input.month) params.set("month", input.month);
  if (input.date) params.set("date", input.date);
  if (input.eventId) params.set("eventId", input.eventId);
  if (input.opener) params.set("opener", input.opener);
  return `/app/calendar?${params.toString()}`;
}

function validCalendarOpener(value: string) {
  return /^(?:add|(?:day|event|more|activity):[a-z0-9-]+)$/i.test(value) ? value : undefined;
}

function calendarErrorMessage(error: unknown) {
  if (error instanceof Error && error.message === "invalid_date_range") {
    return "End time must be after start time.";
  }
  return "Could not save this event.";
}
