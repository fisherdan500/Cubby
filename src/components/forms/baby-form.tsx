"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

const pendingKey = "cubby:baby-create-operation";
type OperationResult = { status: "open" | "pending" | "completed" | "rejected" | "stale" | "expired"; operationId: string; code?: string };

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

async function parseResult(response: Response): Promise<OperationResult> {
  const result = await response.json() as { ok?: boolean; data?: OperationResult; error?: { message?: string } };
  if (!result.ok || !result.data) throw new Error(result.error?.message ?? "Could not save this baby.");
  return result.data;
}

export function BabyForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function complete() {
    sessionStorage.removeItem(pendingKey);
    router.refresh();
    (document.getElementById("baby-form") as HTMLFormElement | null)?.reset();
  }

  async function submit(formData: FormData) {
    setError("");
    const retained = sessionStorage.getItem(pendingKey);
    const id = retained ?? operationId();
    try {
      if (retained) {
        const result = await parseResult(await fetch(`/api/browser-operations/${id}`, { cache: "no-store" }));
        if (result.status === "completed") {
          await complete();
        } else if (result.status === "pending") {
          setError("This baby request is still in progress. Reconcile it before changing it again.");
        } else {
          sessionStorage.removeItem(pendingKey);
          setError("This baby request is no longer available. Refresh and try again.");
        }
        return;
      }

      sessionStorage.setItem(pendingKey, id);
      const issued = await parseResult(await fetch("/api/babies/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: id })
      }));
      if (issued.status === "pending") {
        setError("This baby request is still in progress. Reconcile it before changing it again.");
        return;
      }
      if (issued.status !== "open") {
        sessionStorage.removeItem(pendingKey);
        setError("This baby request is no longer available. Refresh and try again.");
        return;
      }

      const result = await parseResult(await fetch("/api/babies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...Object.fromEntries(formData), operationId: id })
      }));
      if (result.status === "completed") {
        await complete();
      } else if (result.status === "pending") {
        setError("This baby request is still in progress. Reconcile it before changing it again.");
      } else {
        sessionStorage.removeItem(pendingKey);
        setError("This baby changed before your request completed. Refresh and try again.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach Cubby. Reconcile this request before retrying.");
    }
  }

  return (
    <form id="baby-form" action={submit} className="space-y-3">
      <Input name="name" placeholder="Baby name" required />
      <Input name="birthDate" type="date" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Input name="feedingWarningMinutes" type="number" min="1" placeholder="Feed warning minutes" defaultValue="240" />
        <Input name="diaperWarningMinutes" type="number" min="1" placeholder="Diaper warning minutes" defaultValue="240" />
        <Input name="sleepWarningMinutes" type="number" min="1" placeholder="Timer warning minutes" defaultValue="360" />
      </div>
      <Textarea name="notes" placeholder="Notes" />
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <Button>Add baby</Button>
    </form>
  );
}
