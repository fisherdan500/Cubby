"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Preview = {
  legacyPartial: boolean;
  checksumVerified: boolean;
  checksum?: string;
  householdName: string;
  exportedAt: string | null;
  counts: Record<string, number>;
  exclusions: string[];
};

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function BackupRestoreForm({ targetHouseholdName }: { targetHouseholdName: string }) {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<"preview" | "restore" | null>(null);
  const [message, setMessage] = useState("");

  async function selectFile(file: File | null) {
    setSelectedFile(file);
    setPreview(null);
    setConfirmation("");
    setMessage("");
    if (!file) return;
    setPending("preview");
    try {
      const response = await fetch("/api/backups/restore/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: file
      });
      const result = await response.json() as ApiResult<Preview>;
      if (!result.ok) throw new Error(result.error.message);
      setPreview(result.data);
      setMessage("Backup preview is ready. Review it before restoring.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cubby could not preview this backup.");
    } finally {
      setPending(null);
    }
  }

  async function restore() {
    if (!selectedFile || !preview || confirmation !== targetHouseholdName) {
      setMessage("Type the current household name exactly to confirm restore.");
      return;
    }
    setPending("restore");
    setMessage("");
    try {
      const response = await fetch("/api/backups/restore", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cubby-restore-confirmation": encodeURIComponent(confirmation),
          "x-cubby-backup-checksum": preview.checksum ?? "legacy-v1"
        },
        body: selectedFile
      });
      const result = await response.json() as ApiResult<{ restored: number; counts?: Record<string, number> }>;
      if (!result.ok) throw new Error(result.error.message);
      setMessage(`Restore complete. Recovered ${result.data.restored} records. Refreshing Cubby…`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cubby could not restore this backup.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-2">
        <label htmlFor="backup-file" className="block text-sm font-bold">Cubby JSON backup</label>
        <Input id="backup-file" type="file" accept="application/json,.json" disabled={pending !== null}
          onChange={(event) => void selectFile(event.currentTarget.files?.[0] ?? null)} />
      </div>
      {pending === "preview" ? <p className="text-sm text-muted-foreground">Validating backup…</p> : null}
      {preview ? (
        <section className="space-y-3 rounded-lg border border-border bg-muted/40 p-4" aria-label="Backup preview">
          <div>
            <p className="font-black">{preview.householdName}</p>
            <p className="text-sm text-muted-foreground">Exported {preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : "by legacy Cubby"}</p>
          </div>
          {preview.legacyPartial ? (
            <p className="rounded-md bg-warning/15 p-3 text-sm font-bold">Legacy v1 partial backup: only its supported babies, activities, appearance, and units can be recovered.</p>
          ) : <p className="text-sm">Checksum verified.</p>}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(preview.counts).map(([label, count]) => (
              <div key={label} className="rounded-md bg-card p-2"><dt className="text-xs capitalize text-muted-foreground">{label}</dt><dd className="font-black">{count}</dd></div>
            ))}
          </dl>
          <div>
            <p className="text-sm font-bold">Not included</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{preview.exclusions.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="space-y-2">
            <label htmlFor="restore-confirmation" className="block text-sm font-bold">
              Type the current household name exactly: <span className="break-words">{targetHouseholdName}</span>
            </label>
            <Input id="restore-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
          </div>
          <Button type="button" onClick={restore} disabled={pending !== null || confirmation !== targetHouseholdName}>
            {pending === "restore" ? "Restoring…" : "Restore this backup"}
          </Button>
        </section>
      ) : null}
      {message ? <p aria-live="polite" className="rounded-md bg-muted p-3 text-sm">{message}</p> : null}
    </div>
  );
}
