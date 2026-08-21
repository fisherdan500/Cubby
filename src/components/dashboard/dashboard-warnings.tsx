"use client";

import { useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";
import type { DashboardWarningItem } from "@/server/services/dashboard";

type WarningOperationStatus = {
  status: "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
};
type Partition = { version: 1; scope: "household"; partition: string };
type InMemoryWarningOperation = { partition: string; operationId: string };

function operationStorageKey(partition: string, key: string) {
  return `cubby:dashboard-warning-operation:${partition}:${key}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.version !== 1 || body.data.scope !== "household") {
    throw new Error(body?.error?.message ?? "Could not establish the current household operation scope.");
  }
  return body.data;
}

function readOperationId(storageKey: string) {
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
    // Storage failure must not affect the request path.
  }
}

function clearOperationId(storageKey: string) {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Storage failure must not affect the terminal server outcome.
  }
}

async function issueWarningReservation(warning: DashboardWarningItem) {
  const response = await fetch("/api/dashboard/warnings/dismiss/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ babyId: warning.babyId, type: warning.type, fingerprint: warning.fingerprint })
  });
  const result = await response.json().catch(() => null) as { ok?: boolean; data?: WarningOperationStatus } | null;
  if (!response.ok || !result?.ok || !result.data || (result.data.status !== "open" && result.data.status !== "prepared")) {
    throw new Error("warning_issue_unavailable");
  }
  return result.data.operationId;
}

export function DashboardWarnings({ warnings }: { warnings: DashboardWarningItem[] }) {
  const router = useRouter();
  const operationIds = useRef(new Map<string, InMemoryWarningOperation>());
  const [hidden, setHidden] = useState(() => new Set<string>());
  const [error, setError] = useState("");
  const visible = warnings.filter((warning) => !hidden.has(warning.fingerprint));
  if (!visible.length) return null;

  function hideWarning(warning: DashboardWarningItem) {
    setHidden((current) => new Set(current).add(warning.fingerprint));
  }

  function restoreWarning(warning: DashboardWarningItem) {
    setHidden((current) => {
      const next = new Set(current);
      next.delete(warning.fingerprint);
      return next;
    });
  }

  function clearOperation(key: string, storageKey: string) {
    operationIds.current.delete(key);
    clearOperationId(storageKey);
  }

  async function status(operationId: string) {
    const response = await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" });
    const result = await response.json().catch(() => null) as { ok?: boolean; data?: WarningOperationStatus } | null;
    return { response, result };
  }

  async function dismiss(warning: DashboardWarningItem) {
    setError("");
    hideWarning(warning);
    const key = `${warning.type}:${warning.fingerprint}`;
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, operationStorageKey(partition, key));
      const remembered = operationIds.current.get(key);
      if (remembered && remembered.partition !== partition) operationIds.current.delete(key);
      const retained = remembered?.partition === partition ? remembered.operationId : readOperationId(storageKey);
      const operationId = retained ?? await issueWarningReservation(warning);
      operationIds.current.set(key, { partition, operationId });
      retainOperationId(storageKey, operationId);
      if (retained) {
        const { response, result } = await status(operationId);
        if (response.status === 404) {
          restoreWarning(warning);
          setError("This warning request could not be reconciled. Refresh before trying again.");
          return;
        }
        if (isAuthorizedBrowserOperation410(response.status, result, operationId)) {
          clearOperation(key, storageKey);
          restoreWarning(warning);
          setError("This warning request is no longer available. Refresh and try again.");
          return;
        }
        if (!response.ok || !result?.ok || !result.data) throw new Error("warning_operation_status_unavailable");
        if (result.data.status === "completed") {
          clearOperation(key, storageKey);
          router.refresh();
          return;
        }
        if (result.data.status === "pending") {
          restoreWarning(warning);
          setError("Saving is still in progress. Keep this page open and try again.");
          return;
        }
        if (result.data.status === "stale" || result.data.status === "rejected" || result.data.status === "expired") {
          restoreWarning(warning);
          setError("This warning could not be dismissed. Refresh and try again.");
          return;
        }
        if (result.data.status !== "open" && result.data.status !== "prepared") {
          restoreWarning(warning);
          setError("This warning request could not be reconciled. Refresh before trying again.");
          return;
        }
      }

      const response = await fetch("/api/dashboard/warnings/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          babyId: warning.babyId,
          type: warning.type,
          fingerprint: warning.fingerprint
        })
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; data?: WarningOperationStatus } | null;
      if (isAuthorizedBrowserOperation410(response.status, result, operationId)) {
        clearOperation(key, storageKey);
        restoreWarning(warning);
        setError("This warning request expired. Try again to open a new request.");
        return;
      }
      if (response.status === 404) {
        restoreWarning(warning);
        setError("This warning request could not be reconciled. Refresh before trying again.");
        return;
      }
      if (!response.ok || !result?.ok || !result.data) throw new Error("warning_dismissal_unavailable");
      if (result.data.status === "completed") {
        clearOperation(key, storageKey);
        router.refresh();
        return;
      }
      if (result.data.status === "pending") {
        restoreWarning(warning);
        setError("Saving is still in progress. Keep this page open and try again.");
        return;
      }
      restoreWarning(warning);
      setError("This warning could not be dismissed. Refresh and try again.");
    } catch {
      restoreWarning(warning);
      setError("Could not reach Cubby. Check your connection and try again.");
    }
  }

  return (
    <Card className="border-accent bg-accent/10">
      <div className="flex gap-3">
        <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">Needs a glance</h2>
          <p className="text-sm text-muted-foreground">{visible.map((warning) => warning.message).join(" - ")}</p>
        </div>
        <button
          type="button"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Dismiss warning"
          onClick={() => void Promise.all(visible.map(dismiss))}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {error ? <p className="mt-2 text-sm font-bold text-danger" role="alert">{error}</p> : null}
    </Card>
  );
}
