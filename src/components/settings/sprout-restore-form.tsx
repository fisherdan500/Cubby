"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SproutPreview = {
  source: {
    filename?: string;
    format: string;
    envPresent: boolean;
    encHashPresent: boolean;
  };
  counts: Record<string, number>;
  activityCounts: Record<string, number>;
  skippedTables: Record<string, number>;
  warnings: string[];
  result?: {
    created: number;
    skipped: number;
    warnings: string[];
  };
};

export function SproutRestoreForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SproutPreview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  async function upload(endpoint: string) {
    if (!file) {
      setMessage("Choose a Sprout Track .zip, .db, or data.json file.");
      return null;
    }
    const formData = new FormData();
    formData.set("file", file);
    const response = await fetch(endpoint, { method: "POST", body: formData });
    const result = await response.json();
    if (!result.ok) {
      setMessage(result.error.message);
      return null;
    }
    return result.data as SproutPreview;
  }

  async function previewFile() {
    setBusy("preview");
    setMessage("");
    setPreview(null);
    try {
      const data = await upload("/api/backups/sprout/preview");
      if (data) {
        setPreview(data);
        setMessage("Sprout backup preview is ready.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function importFile() {
    setBusy("import");
    setMessage("");
    try {
      const data = await upload("/api/backups/sprout/import");
      if (data) {
        setPreview(data);
        setMessage(`Imported ${data.result?.created ?? 0} items. Skipped ${data.result?.skipped ?? 0} existing or unsupported items.`);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Input
        type="file"
        accept=".zip,.db,.json,application/zip,application/json"
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setPreview(null);
          setMessage("");
        }}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={previewFile} disabled={!file || busy !== null}>
          {busy === "preview" ? "Previewing..." : "Preview Sprout backup"}
        </Button>
        <Button type="button" variant="secondary" onClick={importFile} disabled={!file || !preview || busy !== null}>
          {busy === "import" ? "Importing..." : "Import previewed backup"}
        </Button>
      </div>

      {message ? <p className="rounded-md bg-muted p-3 text-sm">{message}</p> : null}

      {preview ? (
        <div className="space-y-4 rounded-lg border border-border bg-card/70 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Babies" value={preview.counts.babies} />
            <Stat label="Activities" value={preview.counts.activities} />
            <Stat label="Contacts" value={preview.counts.contacts} />
            <Stat label="Duplicates" value={preview.counts.duplicates} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Info label="Format" value={preview.source.format} />
            <Info label="Environment file" value={preview.source.envPresent ? "Detected" : "Not included"} />
            <Info label="ENC_HASH" value={preview.source.encHashPresent ? "Detected" : "Not included"} />
            <Info label="Calendar events" value={String(preview.counts.calendarEvents ?? 0)} />
          </div>
          {Object.keys(preview.activityCounts).length ? (
            <div>
              <p className="mb-2 text-sm font-bold">Activity rows</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(preview.activityCounts).map(([type, count]) => (
                  <span key={type} className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {preview.warnings.length ? (
            <div className="space-y-2">
              {preview.warnings.map((warning) => (
                <p key={warning} className="rounded-md bg-accent/15 p-3 text-sm text-foreground">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-2xl font-black">{value ?? 0}</p>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="font-bold">{value}</p>
    </div>
  );
}
