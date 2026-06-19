"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ApiKeyForm() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    setSecret("");
    const scopes = String(formData.get("scopes") || "read")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const response = await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        scopes,
        babyId: formData.get("babyId") || undefined,
        expiresAt: formData.get("expiresAt") || undefined
      })
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSecret(result.data.secret);
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-3">
      <Input name="name" placeholder="Key name" required />
      <Input name="scopes" defaultValue="read,write" placeholder="read,write" />
      <Input name="babyId" placeholder="Optional baby ID restriction" />
      <Input name="expiresAt" type="date" />
      {secret ? (
        <p className="rounded-md bg-muted p-3 text-sm">
          Copy this key now: <span className="font-mono font-bold">{secret}</span>
        </p>
      ) : null}
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button>Create API key</Button>
    </form>
  );
}

export function RevokeApiKeyButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch(`/api/settings/api-keys/${id}/revoke`, { method: "POST" });
        router.refresh();
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
