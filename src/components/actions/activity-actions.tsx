"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  label
}: {
  id: string;
  kind: string;
  endpoint: string;
  label: string;
}) {
  const router = useRouter();
  const operation = useRef<InMemoryOperation>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
          router.refresh();
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
        body: JSON.stringify({ operationId })
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
        router.refresh();
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
      <Button type="button" variant="secondary" disabled={submitting} onClick={() => void submit()}>
        {submitting ? "Saving..." : label}
      </Button>
      {error ? <span role="alert" className="text-xs font-semibold text-danger">{error}</span> : null}
    </span>
  );
}

function TimerButton({ id, operation, label }: { id: string; operation: "stop" | "pause" | "resume"; label: string }) {
  return <ImmediateOperationButton id={id} kind={`timer.${operation}`} endpoint={`/api/timers/${id}/${operation}`} label={label} />;
}

export function StopTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="stop" label="Stop timer" />; }
export function PauseTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="pause" label="Pause" />; }
export function ResumeTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="resume" label="Resume" />; }

export function UndoLastButton() {
  return <ImmediateOperationButton id="latest-at-open" kind="undo-last" endpoint="/api/activities/undo-last" label="Undo last" />;
}
