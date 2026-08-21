"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createCalendarEventAction, issueCalendarEventAction } from "@/app/app/calendar/actions";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type CalendarOperationStatus = {
  status: "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
  outcome?: { eventId?: string };
};
type Partition = { version: 1; scope: "household"; partition: string };
type InMemoryCalendarOperation = {
  partition: string;
  storageKey: string;
  intentKey: string;
  target: string;
  id: string;
};

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
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

function calendarStorageKey(partition: string, intentKey: string) {
  return `cubby:calendar-operation:${partition}:${intentKey}`;
}

function readRetainedOperationId(storageKey: string) {
  try {
    return sessionStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function retainOperationId(storageKey: string, id: string) {
  try {
    sessionStorage.setItem(storageKey, id);
  } catch {
    // A browser that blocks session storage still retains the in-memory retry.
  }
}

function clearRetainedOperationId(storageKey: string) {
  try {
    sessionStorage.removeItem(storageKey);
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
  const operation = useRef<InMemoryCalendarOperation>();
  const storageKeyRef = useRef<string>();
  const [error, setError] = useState(fallbackError ?? "");
  const [submitting, setSubmitting] = useState(false);

  function clearOperation(_intentKey: string) {
    if (storageKeyRef.current) clearRetainedOperationId(storageKeyRef.current);
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
      setError("This event request could not be reconciled. Refresh before trying again.");
      return false;
    }
    if (isAuthorizedBrowserOperation410(response.status, result, operationId)) {
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
      setError(inlineMessage(result.data.status === "rejected" ? "rejected" : "stale"));
      return false;
    }
    return result.data.status === "open" || result.data.status === "prepared";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const intentKey = calendarIntentKey(formData);
    setError("");
    setSubmitting(true);
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, calendarStorageKey(partition, intentKey));
      storageKeyRef.current = storageKey;
      if (operation.current && (
        operation.current.partition !== partition ||
        operation.current.storageKey !== storageKey ||
        operation.current.intentKey !== intentKey ||
        operation.current.target !== successHref
      )) operation.current = undefined;
      const retained = operation.current?.intentKey === intentKey
        ? operation.current.id
        : readRetainedOperationId(storageKey);
      let operationId = retained;
      if (retained) {
        if (!await reconcile(intentKey, retained)) return;
        operation.current = { partition, storageKey, intentKey, target: successHref, id: retained };
      }
      if (!operationId) {
        const issued = await issueCalendarEventAction(formData);
        if ((issued.status !== "open" && issued.status !== "prepared") || !issued.operationId) throw new Error("calendar_operation_issue_unavailable");
        operationId = issued.operationId;
        operation.current = { partition, storageKey, intentKey, target: successHref, id: operationId };
        retainOperationId(storageKey, operationId);
      }
      formData.set("operationId", operationId);
      const result = await createCalendarEventAction(formData);
      if (result.status === "completed") {
        complete(intentKey, result.eventId);
        return;
      }
      if (result.status === "pending") {
        setError("Saving is still in progress. Keep this form open and try again.");
        return;
      }
      if (result.status === "expired" && isAuthorizedBrowserOperation410(410, result, operationId)) {
        clearOperation(intentKey);
        setError("This event request expired. Submit again to open a new request.");
        return;
      }
      if (result.status === "stale" || result.status === "rejected") {
        setError(inlineMessage(result.status));
        return;
      }
      setError("Reconcile this event request before trying again.");
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col" aria-busy={submitting}>
      {error ? <div role="alert" aria-live="assertive" className="rounded-lg border border-danger/40 bg-danger/15 p-3 text-sm font-bold text-danger">{error}</div> : null}
      {children}
    </form>
  );
}
