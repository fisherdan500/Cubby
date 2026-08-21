"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type LifecycleAction = "deactivate" | "reactivate";
type RetainedLifecycleOperation = { operationId: string; action: LifecycleAction };
type InMemoryLifecycleOperation = RetainedLifecycleOperation & { partition: string; storageKey: string; babyId: string };

type Partition = { version: 1; scope: "household"; partition: string };

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

function lifecycleOperationStorageKey(partition: string, babyId: string) {
  return `cubby:baby-lifecycle-operation:${partition}:${babyId}`;
}

function readRetainedOperation(storageKey: string): RetainedLifecycleOperation | undefined {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RetainedLifecycleOperation>;
    if (
      typeof parsed.operationId === "string" &&
      (parsed.action === "deactivate" || parsed.action === "reactivate")
    ) {
      return { operationId: parsed.operationId, action: parsed.action };
    }
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Storage failure must not affect the request path.
  }
  return undefined;
}

export function BabyLifecycleButton({
  babyId,
  babyName,
  inactive,
  className
}: {
  babyId: string;
  babyName: string;
  inactive: boolean;
  className?: string;
}) {
  const router = useRouter();
  const operation = useRef<InMemoryLifecycleOperation>();
  const storageKeyRef = useRef<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const action = inactive ? "reactivate" : "deactivate";
    if (action === "deactivate" && !window.confirm(`Deactivate ${babyName}? Existing history will remain available.`)) return;

    setSubmitting(true);
    setError("");

    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, lifecycleOperationStorageKey(partition, babyId));
      storageKeyRef.current = storageKey;
      if (operation.current && (
        operation.current.partition !== partition ||
        operation.current.storageKey !== storageKey ||
        operation.current.babyId !== babyId ||
        operation.current.action !== action
      )) operation.current = undefined;
      const retained = operation.current ?? readRetainedOperation(storageKey);
      let next = retained ?? { operationId: "", action };
      if (retained) {
        const response = await fetch(`/api/browser-operations/${next.operationId}`, { cache: "no-store" });
        const result = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: string } } | null;
        const status = result?.ok ? result.data?.status : undefined;
        if (isAuthorizedBrowserOperation410(response.status, result, next.operationId)) {
          clearOperation();
          next = { operationId: "", action };
          operation.current = { ...next, partition, storageKey, babyId };
        } else if (status === "completed") {
          clearOperation();
          router.refresh();
          return;
        } else if (status === "prepared") {
          operation.current = { ...next, partition, storageKey, babyId };
        } else if (status === "pending") {
          setError("Saving is still in progress. Reconcile this baby request before trying again.");
          return;
        } else if (status === "stale" || status === "rejected") {
          setError("This baby request is no longer current. Refresh before trying again.");
          return;
        } else {
          setError("Reconcile this baby request before trying again.");
          return;
        }
      }

      if (!next.operationId) {
        const issueResponse = await fetch(`/api/babies/${babyId}/${action}?issue=1`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
        });
        const issueResult = await issueResponse.json().catch(() => null) as { ok?: boolean; data?: { operationId?: string; status?: string } } | null;
        if (!issueResponse.ok || !issueResult?.ok || typeof issueResult.data?.operationId !== "string" ||
          (issueResult.data.status !== "open" && issueResult.data.status !== "prepared")) {
          throw new Error("baby_operation_issue_unavailable");
        }
        next = { operationId: issueResult.data.operationId, action };
        operation.current = { ...next, partition, storageKey, babyId };
      }
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // A browser that blocks session storage still retains the in-memory retry.
      }
      const response = await fetch(`/api/babies/${babyId}/${next.action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: next.operationId })
      });
      const result = (await response.json().catch(() => null)) as
        | { ok: true; data?: { status?: string } }
        | { ok: false; error?: { message?: string } }
        | null;
      const status = result?.ok ? result.data?.status : undefined;
      if (isAuthorizedBrowserOperation410(response.status, result, next.operationId)) {
        clearOperation();
        setError("This baby request expired. Try again to open a new request.");
        return;
      }
      if (status === "completed") {
        clearOperation();
        router.refresh();
        return;
      }
      if (status === "pending") {
        setError("Saving is still in progress. Reconcile this baby request before trying again.");
        return;
      }
      if (status === "stale" || status === "rejected") {
        setError("This baby request is no longer current. Refresh before trying again.");
        return;
      }
      setError(result && !result.ok
        ? result.error?.message ?? "Reconcile this baby request before trying again."
        : "Reconcile this baby request before trying again.");
    } catch {
      setError("Reconcile this baby request before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  function clearOperation() {
    try {
      if (storageKeyRef.current) window.sessionStorage.removeItem(storageKeyRef.current);
    } catch {
      // Storage failure must not affect the terminal server outcome.
    }
    operation.current = undefined;
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant={inactive ? "secondary" : "primary"}
        className="min-h-11"
        disabled={submitting}
        onClick={submit}
      >
        {submitting ? "Saving..." : inactive ? "Reactivate" : "Deactivate"}
      </Button>
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
