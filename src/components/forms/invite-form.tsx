"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function InviteForm() {
  const router = useRouter();
  const [acceptUrl, setAcceptUrl] = useState("");
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    setAcceptUrl("");
    const response = await fetch("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAcceptUrl(`${window.location.origin}${result.data.acceptUrl}`);
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-3">
      <Input name="email" type="email" placeholder="caretaker@example.com" required />
      <select name="role" className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <option value="caretaker">Caretaker</option>
        <option value="parent">Parent</option>
        <option value="read_only">Read only</option>
      </select>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {acceptUrl ? (
        <div className="rounded-lg bg-muted p-3 text-sm">
          <p className="font-semibold">Invite link</p>
          <p className="break-all text-muted-foreground">{acceptUrl}</p>
        </div>
      ) : null}
      <Button>Invite caretaker</Button>
    </form>
  );
}
