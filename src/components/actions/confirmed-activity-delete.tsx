"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activityDeleteError } from "@/lib/activity-delete";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type DeleteOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };
type InMemoryDeleteOperation = { partition: string; storageKey: string; target: string; operationId: string };

function deleteStorageKey(partition: string, id: string) {
  return `cubby:activity-delete-operation:${partition}:${id}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

function readRetainedOperationId(storageKey: string) {
  try {
    return sessionStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function retainOperationId(storageKey: string, operationId: string) {
  try {
    sessionStorage.setItem(storageKey, operationId);
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

async function operationResponse(response: Response) {
  const result = await response.json().catch(() => null) as
    | { ok: true; data?: { status?: DeleteOperationStatus; operationId?: string } }
    | { ok: false; error?: { message?: string } }
    | null;
  return { response, result, status: result?.ok ? result.data?.status : undefined };
}

export function ConfirmedActivityDelete({
  id,
  returnTo,
  trigger = "button"
}: {
  id: string;
  returnTo: string;
  // "icon" is the small trash control used in the activity page's bottom action bar. It keeps the
  // same two-step confirmation - that confirmation, not the trigger's size, is what prevents an
  // accidental delete - but the question opens upward from the bar, next to the thumb that tapped it.
  trigger?: "button" | "icon";
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const hasOpened = useRef(false);
  const triggerContainer = useRef<HTMLDivElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const operationId = useRef<InMemoryDeleteOperation>();
  const storageKeyRef = useRef<string>();

  useEffect(() => {
    if (confirming) confirmationHeading.current?.focus();
    else if (hasOpened.current) triggerContainer.current?.querySelector("button")?.focus();
  }, [confirming]);

  function clearOperation() {
    if (storageKeyRef.current) clearRetainedOperationId(storageKeyRef.current);
    operationId.current = undefined;
  }

  function complete() {
    clearOperation();
    router.replace(returnTo);
    router.refresh();
  }

  async function remove() {
    setSubmitting(true);
    setError("");
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, deleteStorageKey(partition, id));
      const target = `/api/activities/${encodeURIComponent(id)}`;
      storageKeyRef.current = storageKey;
      if (operationId.current && (
        operationId.current.partition !== partition ||
        operationId.current.storageKey !== storageKey ||
        operationId.current.target !== target
      )) operationId.current = undefined;
      let current = operationId.current?.operationId ?? readRetainedOperationId(storageKey);
      if (current) {
        const reconciled = await operationResponse(await fetch(`/api/browser-operations/${current}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(reconciled.response.status, reconciled.result, current)) {
          clearOperation();
          current = undefined;
        } else if (reconciled.status === "completed") {
          complete();
          return;
        } else if (reconciled.status === "prepared") {
          operationId.current = { partition, storageKey, target, operationId: current };
        } else if (reconciled.status === "pending") {
          setError("Deletion is still in progress. Reconcile it before trying again.");
          return;
        } else if (reconciled.status === "stale" || reconciled.status === "rejected") {
          setError("This deletion request is no longer current. Refresh before trying again.");
          return;
        } else {
          setError("This deletion request could not be reconciled. Refresh before trying again.");
          return;
        }
      }

      if (!current) {
        const issued = await operationResponse(await fetch(`${target}?issue=1`, {
          method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({})
        }));
        if (!issued.response.ok || !issued.result?.ok || (issued.status !== "open" && issued.status !== "prepared")) {
          throw new Error("activity_delete_issue_unavailable");
        }
        current = issued.result.data?.operationId;
        if (!current) throw new Error("activity_delete_issue_unavailable");
        operationId.current = { partition, storageKey, target, operationId: current };
        retainOperationId(storageKey, current);
      }
      const result = await operationResponse(await fetch(target, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: current })
      }));
      if (isAuthorizedBrowserOperation410(result.response.status, result.result, current)) {
        clearOperation();
        setError("This deletion request expired. Try again to open a new request.");
        return;
      }
      if (result.status === "completed") {
        complete();
        return;
      }
      if (result.status === "pending") {
        setError("Deletion is still in progress. Reconcile it before trying again.");
        return;
      }
      if (result.status === "stale" || result.status === "rejected") {
        setError("This deletion request is no longer current. Refresh before trying again.");
        return;
      }
      const message = activityDeleteError(result.response.ok, result.result);
      setError(message ?? "Could not delete this activity.");
    } catch {
      setError("Could not reach Cubby. Reconcile this deletion before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (trigger === "icon") {
    return (
      <div
        ref={triggerContainer}
        className="relative shrink-0"
        onKeyDown={(event) => {
          // The popover floats over the page, so Escape backs out of it like any other popup.
          if (event.key === "Escape" && confirming && !submitting) {
            event.preventDefault();
            setConfirming(false);
          }
        }}
      >
        <button
          type="button"
          aria-label="Delete activity"
          aria-expanded={confirming}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-danger/10 hover:text-danger"
          onClick={() => {
            hasOpened.current = true;
            setConfirming((open) => !open);
          }}
        >
          <Trash2 className="h-5 w-5" aria-hidden="true" />
        </button>
        {confirming ? (
          <section
            className="absolute bottom-full right-0 z-10 mb-2 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-danger/40 bg-card p-4 shadow-soft"
            aria-label="Confirm activity deletion"
          >
            <div>
              <h2 ref={confirmationHeading} tabIndex={-1} className="font-black text-danger">Delete this activity?</h2>
              <p className="mt-1 text-sm text-muted-foreground">This cannot be undone.</p>
            </div>
            {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button type="button" variant="danger" disabled={submitting} onClick={remove}>
                {submitting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  if (!confirming) {
    return (
      <div ref={triggerContainer} className="border-t border-danger/25 pt-5">
        <Button
          type="button"
          variant="ghost"
          className="w-full text-danger hover:bg-danger/10 sm:w-auto"
          onClick={() => {
            hasOpened.current = true;
            setConfirming(true);
          }}
        >
          Delete activity
        </Button>
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-danger/40 bg-danger/5 p-4" aria-label="Confirm activity deletion">
      <div>
        <h2 ref={confirmationHeading} tabIndex={-1} className="font-black text-danger">Delete this activity?</h2>
        <p className="mt-1 text-sm text-muted-foreground">This cannot be undone.</p>
      </div>
      {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button type="button" variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>
          Keep activity
        </Button>
        <Button type="button" variant="danger" disabled={submitting} onClick={remove}>
          {submitting ? "Deleting..." : "Delete activity"}
        </Button>
      </div>
    </section>
  );
}
