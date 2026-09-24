"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ACTIVE_TIMERS_CHANGED_EVENT } from "@/lib/active-timer";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type ImmediateOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };
type InMemoryOperation = { partition: string; storageKey: string; target: string; operationId: string };

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

function storageKey(partition: string, kind: string, id: string) {
  return `cubby:activity-operation:${partition}:${kind}:${id}`;
}

function readOperationId(key: string) {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function retainOperationId(key: string, operationId: string) {
  try {
    sessionStorage.setItem(key, operationId);
  } catch {
    // A browser that blocks session storage still retains the in-memory retry.
  }
}

function clearOperationId(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage failure must not affect the terminal server outcome.
  }
}

async function operationResult(response: Response) {
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: ImmediateOperationStatus; operationId?: string } } | null;
  return { response, body, status: body?.ok ? body.data?.status : undefined };
}

function ImmediateOperationButton({
  id,
  kind,
  endpoint,
  label,
  accessibleLabel,
  completedHref,
  submitFields,
  onCompleted
}: {
  id: string;
  kind: string;
  endpoint: string;
  label: string;
  accessibleLabel?: string;
  /**
   * Where to go once the operation has completed. Stopping a timer from the activity's own screen is
   * the end of that activity's business, so it returns to wherever the screen was opened from rather
   * than leaving a stopped timer on display with a Back press still to make.
   */
  completedHref?: string;
  /** Sent with the operation id when submitting, for an operation that names its target. */
  submitFields?: Record<string, string>;
  onCompleted?: () => void;
}) {
  const router = useRouter();
  const operation = useRef<InMemoryOperation>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function completed() {
    if (kind === "timer.stop" || kind === "timer.pause" || kind === "timer.resume") {
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMERS_CHANGED_EVENT, {
        detail: { timerId: id, operation: kind.slice("timer.".length) }
      }));
    } else if (kind === "undo-last") {
      // What was undone may have been a timer just started, or a deleted one brought back.
      window.dispatchEvent(new CustomEvent(ACTIVE_TIMERS_CHANGED_EVENT, { detail: { operation: "undo" } }));
    }
    onCompleted?.();
    if (completedHref) router.replace(completedHref);
    router.refresh();
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const { partition } = await householdPartition();
      const key = await tabScopedBrowserOperationStorageKey(partition, storageKey(partition, kind, id));
      if (operation.current && (
        operation.current.partition !== partition ||
        operation.current.storageKey !== key ||
        operation.current.target !== endpoint
      )) operation.current = undefined;
      let operationId = operation.current?.operationId ?? readOperationId(key);
      if (operationId) {
        const reconciled = await operationResult(await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(reconciled.response.status, reconciled.body, operationId)) {
          clearOperationId(key);
          operation.current = undefined;
          operationId = undefined;
        } else if (reconciled.status === "completed") {
          clearOperationId(key);
          operation.current = undefined;
          completed();
          return;
        } else if (reconciled.status === "prepared") {
          operation.current = { partition, storageKey: key, target: endpoint, operationId };
        } else if (reconciled.status === "pending") {
          setError("This request is still in progress. Reconcile it before trying again.");
          return;
        } else if (reconciled.status === "stale" || reconciled.status === "rejected") {
          setError("This request is no longer current. Refresh before trying again.");
          return;
        } else {
          setError("This request could not be reconciled. Refresh before trying again.");
          return;
        }
      }

      if (!operationId) {
        const issued = await operationResult(await fetch(`${endpoint}?issue=1`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
        }));
        if (!issued.response.ok || !issued.status || (issued.status !== "open" && issued.status !== "prepared")) {
          throw new Error("activity_operation_issue_unavailable");
        }
        operationId = issued.body?.ok ? issued.body.data?.operationId : undefined;
        if (!operationId) throw new Error("activity_operation_issue_unavailable");
        operation.current = { partition, storageKey: key, target: endpoint, operationId };
        retainOperationId(key, operationId);
      }
      const result = await operationResult(await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, ...submitFields })
      }));
      if (isAuthorizedBrowserOperation410(result.response.status, result.body, operationId)) {
        clearOperationId(key);
        operation.current = undefined;
        setError("This request expired. Try again to open a new request.");
        return;
      }
      if (result.status === "completed") {
        clearOperationId(key);
        operation.current = undefined;
        completed();
        return;
      }
      if (result.status === "pending") {
        setError("This request is still in progress. Reconcile it before trying again.");
        return;
      }
      if (result.status === "stale" || result.status === "rejected") {
        setError("This request is no longer current. Refresh before trying again.");
        return;
      }
      setError("This request could not be completed. Reconcile it before trying again.");
    } catch {
      setError("Could not reach Cubby. Reconcile this request before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button aria-label={accessibleLabel} type="button" variant="secondary" disabled={submitting} onClick={() => void submit()}>
        {submitting ? "Saving..." : label}
      </Button>
      {error ? <span role="alert" className="text-xs font-semibold text-danger">{error}</span> : null}
    </span>
  );
}

function TimerButton({ id, operation, label, accessibleLabel, completedHref }: { id: string; operation: "stop" | "pause" | "resume"; label: string; accessibleLabel?: string; completedHref?: string }) {
  return <ImmediateOperationButton id={id} kind={`timer.${operation}`} endpoint={`/api/timers/${id}/${operation}`} label={label} accessibleLabel={accessibleLabel} completedHref={completedHref} />;
}

/**
 * `returnTo` is given only where stopping finishes with the screen you are on: the activity's own
 * page. From the shell's timer bar there is nowhere to go - you are already where you wanted to be.
 */
export function StopTimerButton({ id, returnTo, accessibleLabel }: { id: string; returnTo?: string; accessibleLabel?: string }) { return <TimerButton id={id} operation="stop" label="Stop timer" accessibleLabel={accessibleLabel} completedHref={returnTo} />; }
export function PauseTimerButton({ id, accessibleLabel }: { id: string; accessibleLabel?: string }) { return <TimerButton id={id} operation="pause" label="Pause" accessibleLabel={accessibleLabel} />; }
export function ResumeTimerButton({ id, accessibleLabel }: { id: string; accessibleLabel?: string }) { return <TimerButton id={id} operation="resume" label="Resume" accessibleLabel={accessibleLabel} />; }

/**
 * Without `activityId` this takes back whatever the member most recently added or deleted. With it,
 * the server refuses unless that is still exactly the named entry, so an Undo offered for one entry
 * can never take back a different one.
 */
export function UndoLastButton({ activityId, label = "Undo last", onCompleted }: { activityId?: string; label?: string; onCompleted?: () => void }) {
  return (
    <ImmediateOperationButton
      id={activityId ?? "latest-at-open"}
      kind="undo-last"
      endpoint="/api/activities/undo-last"
      label={label}
      submitFields={activityId ? { activityId } : undefined}
      onCompleted={onCompleted}
    />
  );
}
