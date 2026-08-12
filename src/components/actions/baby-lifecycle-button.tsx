"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type LifecycleAction = "deactivate" | "reactivate";
type RetainedLifecycleOperation = { operationId: string; action: LifecycleAction };

function createBrowserOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

function lifecycleOperationStorageKey(babyId: string) {
  return `cubby:baby-lifecycle-operation:${babyId}`;
}

function readRetainedOperation(babyId: string): RetainedLifecycleOperation | undefined {
  try {
    const raw = window.sessionStorage.getItem(lifecycleOperationStorageKey(babyId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RetainedLifecycleOperation>;
    if (
      typeof parsed.operationId === "string" &&
      (parsed.action === "deactivate" || parsed.action === "reactivate")
    ) {
      return { operationId: parsed.operationId, action: parsed.action };
    }
    window.sessionStorage.removeItem(lifecycleOperationStorageKey(babyId));
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
  const operation = useRef<RetainedLifecycleOperation>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const retained = operation.current ?? readRetainedOperation(babyId);
    const action = retained?.action ?? (inactive ? "reactivate" : "deactivate");
    if (action === "deactivate" && !window.confirm(`Deactivate ${babyName}? Existing history will remain available.`)) return;

    setSubmitting(true);
    setError("");
    const next = retained ?? { operationId: createBrowserOperationId(), action };
    operation.current = next;
    try {
      window.sessionStorage.setItem(lifecycleOperationStorageKey(babyId), JSON.stringify(next));
    } catch {
      // A browser that blocks session storage still retains the in-memory retry.
    }

    try {
      const response = await fetch(`/api/babies/${babyId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: next.operationId })
      });
      const result = (await response.json().catch(() => null)) as
        | { ok: true; data?: { status?: string } }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !result?.ok) {
        setError(result && !result.ok ? result.error?.message ?? "Could not update this baby." : "Could not update this baby.");
        return;
      }
      if (result.data?.status === "completed") {
        clearOperation();
        router.refresh();
        return;
      }
      if (result.data?.status === "pending") {
        setError("Saving is still in progress. Keep this page open and try again.");
        return;
      }
      clearOperation();
      setError("This baby changed before your request completed. Refresh and try again.");
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function clearOperation() {
    try {
      window.sessionStorage.removeItem(lifecycleOperationStorageKey(babyId));
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
