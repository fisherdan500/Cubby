"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import type { AppearanceMode } from "@/domain/appearance";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

const modes = [
  { value: "system" as const, label: "System", description: "Follow this device's light or dark setting." },
  { value: "light" as const, label: "Light", description: "Use light appearance on your signed-in devices." },
  { value: "dark" as const, label: "Dark", description: "Use dark appearance on your signed-in devices." }
];

type OperationResult = {
  status: "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
  outcome?: { appearanceMode?: AppearanceMode; appearanceRevision?: number };
  code?: string;
};

type Partition = { version: 1; scope: "account"; partition: string };

function accountOperationStorageKey(partition: string) {
  return `cubby:account-appearance-operation:${partition}`;
}

async function accountPartition(): Promise<Partition> {
  const response = await fetch("/api/account/browser-operations/partition", { cache: "no-store" });
  const body = await response.json() as { ok?: boolean; data?: Partition; error?: { message?: string } };
  if (!response.ok || !body.ok || !body.data || body.data.version !== 1 || body.data.scope !== "account") {
    throw new Error(body.error?.message ?? "Could not establish the current account operation scope.");
  }
  return body.data;
}

type OperationResponse = { response: Response; result: OperationResult };

async function responseResult(response: Response): Promise<OperationResponse> {
  const body = await response.json() as { ok: boolean; data?: OperationResult; error?: { message?: string } };
  if (!body.ok || !body.data) throw new Error(body.error?.message ?? "Appearance could not be updated.");
  return { response, result: body.data };
}

export function PersonalAppearanceForm({
  initialMode,
  initialRevision
}: {
  initialMode: AppearanceMode;
  initialRevision: number;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [selected, setSelected] = useState<AppearanceMode>(initialMode);
  const [revision, setRevision] = useState(initialRevision);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function apply(result: OperationResult, storageKey: string, responseStatus: number, operationId: string) {
    if (result.status === "completed" && result.outcome?.appearanceMode) {
      setSelected(result.outcome.appearanceMode);
      setRevision((current) => result.outcome?.appearanceRevision ?? current);
      setTheme(result.outcome.appearanceMode);
      sessionStorage.removeItem(storageKey);
      setMessage("Personal appearance saved.");
      router.refresh();
      return true;
    }
    if (isAuthorizedBrowserOperation410(responseStatus, result, operationId)) {
      sessionStorage.removeItem(storageKey);
      setMessage("This appearance request is no longer available. Refresh and choose again.");
      return false;
    }
    if (result.status === "rejected" || result.status === "stale" || result.status === "expired") {
      setMessage(result.code === "stale_revision" ? "Appearance changed in another tab. Refresh and choose again." : "Reconcile this appearance request before trying again.");
    }
    return false;
  }

  async function reconcile(operationId: string, storageKey: string) {
    const response = await fetch(`/api/account/browser-operations/${operationId}`, { cache: "no-store" });
    const operation = await responseResult(response);
    apply(operation.result, storageKey, operation.response.status, operationId);
    return operation;
  }

  async function submitReservation(operationId: string, storageKey: string) {
    const submitted = await responseResult(await fetch("/api/account/appearance", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, appearanceMode: selected })
    }));
    if (!apply(submitted.result, storageKey, submitted.response.status, operationId) && submitted.result.status === "pending") await reconcile(operationId, storageKey);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const { partition } = await accountPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, accountOperationStorageKey(partition));
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const reconciled = await reconcile(retained, storageKey);
        if (reconciled.result.status === "prepared") await submitReservation(retained, storageKey);
        return;
      }

      const issued = await responseResult(await fetch("/api/account/appearance/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }));
      sessionStorage.setItem(storageKey, issued.result.operationId);
      if (apply(issued.result, storageKey, issued.response.status, issued.result.operationId)) return;
      if (issued.result.status === "pending") {
        await reconcile(issued.result.operationId, storageKey);
        return;
      }
      if (issued.result.status === "open" || issued.result.status === "prepared") {
        await submitReservation(issued.result.operationId, storageKey);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Appearance outcome is unknown. Reconcile this request before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-appearance-revision={revision}>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Personal appearance mode">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            role="radio"
            data-appearance-mode={mode.value}
            aria-checked={selected === mode.value}
            tabIndex={selected === mode.value ? 0 : -1}
            onClick={() => setSelected(mode.value)}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
              if (!direction) return;
              event.preventDefault();
              const currentIndex = modes.findIndex((candidate) => candidate.value === selected);
              const nextMode = modes[(currentIndex + direction + modes.length) % modes.length]!.value;
              setSelected(nextMode);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[role="radio"][data-appearance-mode="${nextMode}"]`)?.focus();
            }}
            className="min-h-24 rounded-lg border border-control bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block text-sm font-bold">{mode.label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{mode.description}</span>
          </button>
        ))}
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || selected === initialMode}>
        {saving ? "Saving…" : "Save personal appearance"}
      </Button>
      {message ? <p className="text-sm text-muted-foreground" role="status">{message}</p> : null}
    </div>
  );
}
