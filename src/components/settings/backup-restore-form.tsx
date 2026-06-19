"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

export function BackupRestoreForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");

  async function submit(formData: FormData) {
    setMessage("");
    const raw = String(formData.get("json") || "");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      setMessage("Paste a valid Cubby JSON backup.");
      return;
    }
    const response = await fetch("/api/backups/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setMessage(`Restored ${result.data.restored} activities.`);
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-3">
      <Textarea name="json" placeholder="Paste Cubby JSON backup" className="min-h-56 font-mono text-xs" />
      {message ? <p className="rounded-md bg-muted p-3 text-sm">{message}</p> : null}
      <Button>Restore JSON backup</Button>
    </form>
  );
}
