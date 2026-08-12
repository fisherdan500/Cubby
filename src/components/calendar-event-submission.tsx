"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createCalendarEventAction } from "@/app/app/calendar/actions";

function createBrowserOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

function inlineMessage(status: "stale" | "rejected") {
  return status === "stale"
    ? "This event form is no longer current. Review it and try again."
    : "This event could not be saved. Review it and try again.";
}

function calendarIntentKey(formData: FormData) {
  return JSON.stringify(
    Array.from(formData.entries())
      .filter(([key]) => key !== "operationId")
      .map(([key, value]) => [key, typeof value === "string" ? value : value.name] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function readRetainedOperationId(intentKey: string) {
  try {
    return sessionStorage.getItem(`cubby:calendar-operation:${intentKey}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function retainOperationId(intentKey: string, id: string) {
  try {
    sessionStorage.setItem(`cubby:calendar-operation:${intentKey}`, id);
  } catch {
    // A browser that blocks session storage still retains the in-memory retry.
  }
}

function clearRetainedOperationId(intentKey: string) {
  try {
    sessionStorage.removeItem(`cubby:calendar-operation:${intentKey}`);
  } catch {
    // Storage failure must not affect the terminal server outcome.
  }
}

export function CalendarEventSubmission({
  children,
  fallbackError,
  successHref
}: {
  children: ReactNode;
  fallbackError?: string;
  successHref: string;
}) {
  const router = useRouter();
  const operation = useRef<{ intentKey: string; id: string }>();
  const [error, setError] = useState(fallbackError ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const intentKey = calendarIntentKey(formData);
    setError("");
    setSubmitting(true);
    if (operation.current?.intentKey !== intentKey) {
      operation.current = { intentKey, id: readRetainedOperationId(intentKey) ?? createBrowserOperationId() };
      retainOperationId(intentKey, operation.current.id);
    }
    formData.set("operationId", operation.current.id);
    try {
      const result = await createCalendarEventAction(formData);
      if (result.status === "completed") {
        clearRetainedOperationId(intentKey);
        router.push(`${successHref}&eventId=${encodeURIComponent(result.eventId)}`);
        router.refresh();
        return;
      }
      if (result.status === "pending") {
        setError("Saving is still in progress. Keep this form open and try again.");
        return;
      }
      clearRetainedOperationId(intentKey);
      operation.current = undefined;
      setError(inlineMessage(result.status));
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col" aria-busy={submitting}>
      {error ? <div className="rounded-lg border border-danger/40 bg-danger/15 p-3 text-sm font-bold text-danger">{error}</div> : null}
      {children}
    </form>
  );
}
