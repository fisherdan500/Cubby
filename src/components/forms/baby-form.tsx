"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type OperationResult = { status: "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired"; operationId: string; code?: string };
type Partition = { version: 1; scope: "household"; partition: string };

function babyStorageKey(partition: string) {
  return `cubby:baby-create-operation:${partition}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

async function parseResult(response: Response) {
  const result = await response.json() as { ok?: boolean; data?: OperationResult; error?: { message?: string } };
  if (!result.ok || !result.data) throw new Error(result.error?.message ?? "Could not save this baby.");
  return { response, result: result.data };
}

export function BabyForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function complete(storageKey: string) {
    sessionStorage.removeItem(storageKey);
    router.refresh();
    (document.getElementById("baby-form") as HTMLFormElement | null)?.reset();
  }

  async function onSubmit(formData: FormData) {
    setError("");
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, babyStorageKey(partition));
      let operationId = sessionStorage.getItem(storageKey) ?? undefined;
      if (operationId) {
        const status = await parseResult(await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(status.response.status, status.result, operationId)) {
          sessionStorage.removeItem(storageKey);
          operationId = undefined;
        } else if (status.result.status === "completed") {
          await complete(storageKey);
          return;
        } else if (status.result.status === "prepared") {
          // Continue below with the same server-issued reservation.
        } else if (status.result.status === "pending") {
          setError("This baby request is still in progress. Reconcile it before changing it again.");
          return;
        } else {
          setError("This baby request is no longer current. Reconcile it before trying again.");
          return;
        }
      }

      if (!operationId) {
        const issued = await parseResult(await fetch("/api/babies/issue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        }));
        if (issued.result.status === "pending") {
          setError("This baby request is still in progress. Reconcile it before changing it again.");
          return;
        }
        if (issued.result.status !== "open" && issued.result.status !== "prepared") {
          setError("This baby request is no longer current. Reconcile it before trying again.");
          return;
        }
        operationId = issued.result.operationId;
        sessionStorage.setItem(storageKey, operationId);
      }

      const submitted = await parseResult(await fetch("/api/babies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...Object.fromEntries(formData), operationId })
      }));
      if (isAuthorizedBrowserOperation410(submitted.response.status, submitted.result, operationId)) {
        sessionStorage.removeItem(storageKey);
        setError("This baby request expired. Submit again to open a new request.");
      } else if (submitted.result.status === "completed") {
        await complete(storageKey);
      } else if (submitted.result.status === "pending") {
        setError("This baby request is still in progress. Reconcile it before changing it again.");
      } else {
        setError("This baby request is no longer current. Reconcile it before trying again.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach Cubby. Reconcile this request before retrying.");
    }
  }

  return (
    <form id="baby-form" action={onSubmit} className="space-y-3">
      <label className="sr-only" htmlFor="baby-name">Baby name</label>
      <Input id="baby-name" name="name" placeholder="Baby name" required />
      <label className="sr-only" htmlFor="baby-birth-date">Birth date</label>
      <Input id="baby-birth-date" name="birthDate" type="date" />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="sr-only" htmlFor="baby-feeding-warning">Feeding warning minutes</label>
        <Input id="baby-feeding-warning" name="feedingWarningMinutes" type="number" min="1" placeholder="Feed warning minutes" defaultValue="240" />
        <label className="sr-only" htmlFor="baby-diaper-warning">Diaper warning minutes</label>
        <Input id="baby-diaper-warning" name="diaperWarningMinutes" type="number" min="1" placeholder="Diaper warning minutes" defaultValue="240" />
        <label className="sr-only" htmlFor="baby-timer-warning">Timer warning minutes</label>
        <Input id="baby-timer-warning" name="sleepWarningMinutes" type="number" min="1" placeholder="Timer warning minutes" defaultValue="360" />
      </div>
      <label className="sr-only" htmlFor="baby-notes">Notes</label>
      <Textarea id="baby-notes" name="notes" placeholder="Notes" />
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <Button>Add baby</Button>
    </form>
  );
}
