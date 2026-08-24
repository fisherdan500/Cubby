"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

export function RevokeApiKeyButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        const partitionResponse = await fetch("/api/browser-operations/partition", { cache: "no-store" });
        const partitionBody = await partitionResponse.json();
        const partition = partitionBody?.data?.partition;
        if (!partitionResponse.ok || typeof partition !== "string") return;
        const storageKey = await tabScopedBrowserOperationStorageKey(partition, `cubby:api-key-revoke-operation:${partition}:${id}`);
        let operationId = sessionStorage.getItem(storageKey) ?? "";
        if (operationId) {
          const statusResponse = await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" });
          const statusBody = await statusResponse.json();
          if (statusResponse.ok && statusBody?.data?.status === "completed") {
            sessionStorage.removeItem(storageKey); router.refresh(); return;
          }
          if (statusResponse.status === 410) {
            sessionStorage.removeItem(storageKey); operationId = "";
          }
        }
        if (!operationId) {
          const issued = await fetch(`/api/settings/api-keys/${id}/revoke?issue=1`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
          });
          const issuedBody = await issued.json();
          operationId = issuedBody?.data?.operationId ?? "";
          if (!issued.ok || !operationId) return;
          sessionStorage.setItem(storageKey, operationId);
        }
        const response = await fetch(`/api/settings/api-keys/${id}/revoke`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
        });
        const body = await response.json();
        if (response.ok && body?.data?.status === "completed") {
          sessionStorage.removeItem(storageKey);
          router.refresh();
        }
      }}
    >
      Revoke
    </Button>
  );
}

export function WebhookForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    const events = String(formData.get("events") || "activity_created")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean);
    const response = await fetch("/api/settings/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        url: formData.get("url"),
        events
      })
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-3">
      <Input name="name" placeholder="Webhook name" required />
      <Input name="url" type="url" placeholder="https://example.com/cubby" required />
      <Input name="events" defaultValue="activity_created,activity_updated,activity_deleted,timer_started,timer_stopped" />
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button>Create webhook</Button>
    </form>
  );
}

export function DeleteWebhookButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch(`/api/settings/webhooks/${id}`, { method: "DELETE" });
        router.refresh();
      }}
    >
      Disable
    </Button>
  );
}
