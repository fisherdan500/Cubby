"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";

type Chosen = { attachmentId: string; previewUrl: string; name: string };

/**
 * Choose photos while logging an entry, before the entry exists.
 *
 * Each picture is uploaded privately as it is chosen and stays unused until the save attaches it, so a
 * family can add a photo at the moment they log rather than saving, reopening the entry and coming
 * back to it. The ids are handed up to the form, which sends them with the save; the save then creates
 * the entry and attaches the pictures in one transaction, so both appear or neither does.
 *
 * A picture that fails to upload leaves nothing behind and never blocks the entry being logged.
 */
export function ActivityPhotoPicker({ onChange }: { onChange: (attachmentIds: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  // One upload at a time: a second choice must not race the first and attach the same picture twice.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Preview URLs are only valid while this screen is open.
  useEffect(() => () => { for (const photo of chosen) URL.revokeObjectURL(photo.previewUrl); }, [chosen]);

  async function add(file: File) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Only the request is guarded here: a fault after a successful upload must not be reported as a
      // connection problem, which would send the family looking in the wrong place.
      let response: Response;
      try {
        response = await fetch("/api/attachments/feed-photos", {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        });
      } catch {
        if (mounted.current) setError("Could not reach Cubby. Check your connection and try again.");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: { attachmentId?: string }; error?: { message?: string } }
        | null;
      if (!mounted.current) return;
      if (!response.ok || !body?.ok || !body.data?.attachmentId) {
        setError(body?.error?.message ?? "That photo could not be added. Try again.");
        return;
      }
      const next = [
        ...chosen,
        { attachmentId: body.data.attachmentId, previewUrl: URL.createObjectURL(file), name: file.name }
      ];
      setChosen(next);
      onChange(next.map((photo) => photo.attachmentId));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  function remove(attachmentId: string) {
    const next = chosen.filter((photo) => photo.attachmentId !== attachmentId);
    const dropped = chosen.find((photo) => photo.attachmentId === attachmentId);
    if (dropped) URL.revokeObjectURL(dropped.previewUrl);
    setChosen(next);
    // Nothing is attached until the entry is saved, so leaving it out of the save is all that is
    // needed; the unclaimed upload expires on its own.
    onChange(next.map((photo) => photo.attachmentId));
  }

  return (
    <div className="space-y-2">
      <span className="block text-sm font-semibold">Photos</span>
      {chosen.length ? (
        <ul className="flex flex-wrap gap-2">
          {chosen.map((photo) => (
            <li key={photo.attachmentId} className="relative">
              {/* A local preview: the picture is not readable from the server until it is attached. */}
              <img src={photo.previewUrl} alt={photo.name} className="h-20 w-20 rounded-lg object-cover" />
              <button
                type="button"
                onClick={() => remove(photo.attachmentId)}
                aria-label={`Remove ${photo.name}`}
                className="absolute -right-1 -top-1 rounded-full bg-background p-1 shadow ring-1 ring-border"
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label
        className={`inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-bold ${
          busy ? "opacity-60" : "cursor-pointer hover:bg-muted"
        }`}
      >
        <ImagePlus aria-hidden className="h-4 w-4" />
        {busy ? "Adding…" : "Add a photo"}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Add a photo"
          disabled={busy}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void add(file);
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
