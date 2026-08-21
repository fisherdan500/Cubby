"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accentThemeDetails, accentThemes, type AccentTheme } from "@/domain/appearance";
import { cn } from "@/lib/utils";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type OperationResult = { status: "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired"; operationId: string; code?: string };
type Partition = { version: 1; scope: "household"; partition: string };

function appearanceOperationStorageKey(partition: string) {
  return `cubby:household-accent-operation:${partition}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json() as { ok?: boolean; data?: Partition; error?: { message?: string } };
  if (!response.ok || !body.ok || !body.data || body.data.version !== 1 || body.data.scope !== "household") {
    throw new Error(body.error?.message ?? "Could not establish the current household operation scope.");
  }
  return body.data;
}

type OperationResponse = { response: Response; result: OperationResult };

async function parseResult(response: Response): Promise<OperationResponse> {
  const body = await response.json() as { ok: boolean; data?: OperationResult; error?: { message?: string } };
  if (!body.ok || !body.data) throw new Error(body.error?.message ?? "Could not save the Family accent.");
  return { response, result: body.data };
}

export function AppearanceForm({ initialTheme }: { initialTheme: AccentTheme }) {
  const router = useRouter();
  const [selected, setSelected] = useState<AccentTheme>(initialTheme);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function reconcile(id: string) {
    const response = await fetch(`/api/browser-operations/${id}`, { cache: "no-store" });
    return parseResult(response);
  }

  async function submitReservation(id: string, storageKey: string) {
    const submitted = await parseResult(await fetch("/api/settings/appearance", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: id, accentTheme: selected })
    }));
    if (submitted.result.status === "completed") {
      sessionStorage.removeItem(storageKey);
      setMessage("Family accent saved.");
      router.refresh();
    } else if (isAuthorizedBrowserOperation410(submitted.response.status, submitted.result, id)) {
      sessionStorage.removeItem(storageKey);
      setMessage("This Family accent request is no longer available. Refresh and choose again.");
    } else if (submitted.result.status === "pending") {
      setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
    } else if (submitted.result.status === "prepared") {
      setMessage("Family accent reservation is ready. Retry this save to submit it.");
    } else {
      setMessage("Reconcile this Family accent request before trying again.");
    }
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, appearanceOperationStorageKey(partition));
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const outcome = await reconcile(retained);
        if (outcome.result.status === "completed") {
          sessionStorage.removeItem(storageKey);
          setMessage("Family accent saved.");
          router.refresh();
        } else if (isAuthorizedBrowserOperation410(outcome.response.status, outcome.result, retained)) {
          sessionStorage.removeItem(storageKey);
          setMessage("This Family accent request is no longer available. Refresh and choose again.");
        } else if (outcome.result.status === "prepared") {
          await submitReservation(retained, storageKey);
        } else if (outcome.result.status === "pending") {
          setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
        } else {
          setMessage("Reconcile this Family accent request before trying again.");
        }
        return;
      }
      const issued = await parseResult(await fetch("/api/settings/appearance/issue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
      }));
      sessionStorage.setItem(storageKey, issued.result.operationId);
      if (issued.result.status === "open" || issued.result.status === "prepared") {
        await submitReservation(issued.result.operationId, storageKey);
      } else if (isAuthorizedBrowserOperation410(issued.response.status, issued.result, issued.result.operationId)) {
        sessionStorage.removeItem(storageKey);
        setMessage("This Family accent request is no longer available. Refresh and choose again.");
      } else if (issued.result.status === "pending") {
        setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
      } else {
        setMessage("Reconcile this Family accent request before trying again.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Family accent outcome is unknown. Reconcile it before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Family accent">
        {accentThemes.map((theme) => {
          const details = accentThemeDetails[theme];
          const active = selected === theme;
          return <button
            key={theme}
            type="button"
            role="radio"
            data-accent-theme={theme}
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setSelected(theme)}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
              if (!direction) return;
              event.preventDefault();
              const currentIndex = accentThemes.indexOf(selected);
              const nextTheme = accentThemes[(currentIndex + direction + accentThemes.length) % accentThemes.length]!;
              setSelected(nextTheme);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[role="radio"][data-accent-theme="${nextTheme}"]`)?.focus();
            }}
            className={cn("relative min-h-24 rounded-lg border bg-card p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary ring-2 ring-primary/25" : "border-border hover:bg-muted")}
          >
            <span className="mb-3 block h-8 w-8 rounded-full border border-black/10" style={{ backgroundColor: details.swatch }} />
            <span className="block text-sm font-bold">{details.label}</span><span className="block text-xs text-muted-foreground">{details.description}</span>
            {active ? <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3.5 w-3.5" /></span> : null}
          </button>;
        })}
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || selected === initialTheme}>{saving ? "Saving..." : "Save Family accent"}</Button>
      {message ? <p className="text-sm text-muted-foreground" role="status">{message}</p> : null}
    </div>
  );
}
