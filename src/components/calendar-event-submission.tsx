"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createCalendarEventAction } from "@/app/app/calendar/actions";

type CalendarOperationStatus = {
  status: "open" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
  outcome?: { eventId?: string };
};

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

  function clearOperation(intentKey: string) {
    clearRetainedOperationId(intentKey);
    operation.current = undefined;
  }

  function complete(intentKey: string, eventId: string) {
    clearOperation(intentKey);
    router.push(`${successHref}&eventId=${encodeURIComponent(eventId)}`);
    router.refresh();
  }

  async function reconcile(intentKey: string, operationId: string) {
    const response = await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" });
    const result = await response.json().catch(() => null) as { ok?: boolean; data?: CalendarOperationStatus } | null;
    if (response.status === 404) {
      clearOperation(intentKey);
      setError("This event request is no longer available. Review the form and try again.");
      return false;
    }
    if (response.status === 410) {
      clearOperation(intentKey);
      setError(inlineMessage("stale"));
      return false;
    }
    if (!response.ok || !result?.ok || !result.data) throw new Error("calendar_operation_status_unavailable");
    if (result.data.status === "completed") {
      const eventId = result.data.outcome?.eventId;
      if (!eventId) {
        clearOperation(intentKey);
        setError(inlineMessage("stale"));
        return false;
      }
      complete(intentKey, eventId);
      return false;
    }
    if (result.data.status === "pending") {
      setError("Saving is still in progress. Keep this form open and try again.");
      return false;
    }
    if (result.data.status === "stale" || result.data.status === "rejected" || result.data.status === "expired") {
      clearOperation(intentKey);
      setError(inlineMessage(result.data.status === "rejected" ? "rejected" : "stale"));
      return false;
    }
    return result.data.status === "open";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const intentKey = calendarIntentKey(formData);
    const retained = operation.current?.intentKey === intentKey
      ? operation.current.id
      : readRetainedOperationId(intentKey);
    setError("");
    setSubmitting(true);
    const operationId = retained ?? createBrowserOperationId();
    operation.current = { intentKey, id: operationId };
    retainOperationId(intentKey, operationId);
    formData.set("operationId", operationId);
    try {
      if (retained && !await reconcile(intentKey, operationId)) return;
      const result = await createCalendarEventAction(formData);
      if (result.status === "completed") {
        complete(intentKey, result.eventId);
        return;
      }
      if (result.status === "pending") {
        setError("Saving is still in progress. Keep this form open and try again.");
        return;
      }
      clearOperation(intentKey);
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
