"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BackupDownloadButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function download() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/backups/export", { method: "POST", cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error?.message ?? "Cubby could not create the backup.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([A-Za-z0-9._-]+)"/);
      const filename = match?.[1] ?? "cubby-backup.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage("Backup downloaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cubby could not create the backup.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={download} disabled={pending}>
        {pending ? "Creating backup…" : "JSON backup"}
      </Button>
      {message ? <p aria-live="polite" className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  );
}
