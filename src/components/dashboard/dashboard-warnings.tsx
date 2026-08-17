"use client";

import { useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import type { DashboardWarningItem } from "@/server/services/dashboard";

type WarningOperationStatus = {
  status: "open" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
};

function operationStorageKey(key: string) {
  return `cubby:dashboard-warning-operation:${key}`;
}

function createBrowserOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

function readOperationId(key: string) {
  try {
    return sessionStorage.getItem(operationStorageKey(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

function retainOperationId(key: string, operationId: string) {
  try {
    sessionStorage.setItem(operationStorageKey(key), operationId);
  } catch {
    // Storage failure must not affect the request path.
  }
}

function clearOperationId(key: string) {
  try {
    sessionStorage.removeItem(operationStorageKey(key));
  } catch {
    // Storage failure must not affect the terminal server outcome.
  }
}

export function DashboardWarnings({ warnings }: { warnings: DashboardWarningItem[] }) {
  const router = useRouter();
  const operationIds = useRef(new Map<string, string>());
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

  function clearOperation(key: string) {
    operationIds.current.delete(key);
    clearOperationId(key);
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
    const retained = operationIds.current.get(key) ?? readOperationId(key);
    const operationId = retained ?? createBrowserOperationId();
    operationIds.current.set(key, operationId);
    retainOperationId(key, operationId);
    try {
      if (retained) {
        const { response, result } = await status(operationId);
        if (response.status === 404) {
          clearOperation(key);
          restoreWarning(warning);
          setError("This warning request is no longer available. Refresh and try again.");
          return;
        }
        if (response.status === 410) {
          clearOperation(key);
          restoreWarning(warning);
          setError("This warning request is no longer available. Refresh and try again.");
          return;
        }
        if (!response.ok || !result?.ok || !result.data) throw new Error("warning_operation_status_unavailable");
        if (result.data.status === "completed") {
          clearOperation(key);
          router.refresh();
          return;
        }
        if (result.data.status === "pending") {
          setError("Saving is still in progress. Keep this page open and try again.");
          return;
        }
        if (result.data.status === "stale" || result.data.status === "rejected" || result.data.status === "expired") {
          clearOperation(key);
          restoreWarning(warning);
          setError("This warning could not be dismissed. Refresh and try again.");
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
      if (response.status === 410 || response.status === 404) {
        clearOperation(key);
        restoreWarning(warning);
        setError("This warning could not be dismissed. Refresh and try again.");
        return;
      }
      if (!response.ok || !result?.ok || !result.data) throw new Error("warning_dismissal_unavailable");
      if (result.data.status === "completed") {
        clearOperation(key);
        router.refresh();
        return;
      }
      if (result.data.status === "pending") {
        setError("Saving is still in progress. Keep this page open and try again.");
        return;
      }
      clearOperation(key);
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
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
