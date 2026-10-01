"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus } from "lucide-react";

import { runFeedOperation } from "@/components/feed/feed-post-actions";

/**
 * Add a photo to a logged entry.
 *
 * Two steps in a fixed order: the picture is uploaded privately, then attached by creating the
 * entry's photo post. An upload that fails must never produce a post -- an empty moment with an error
 * about the wrong step is worse than no moment at all.
 *
 * The photo stays an ordinary feed photo on a real post, which is what keeps private delivery and
 * backups working; the post simply records the entry it belongs to, so Moments shows the two as one.
 */
export function ActivityPhotoControl({
  activityId,
  babyId
}: {
  activityId: string;
  babyId: string | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(file: File) {
    setBusy(true);
    setError(null);
    try {
      // Upload first: the picture stays private and unused until something claims it.
      const response = await fetch("/api/attachments/feed-photos", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: { attachmentId?: string }; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.ok || !body.data?.attachmentId) {
        setError(body?.error?.message ?? "That photo could not be added. Try again.");
        return;
      }

      // Only now does anything become visible, and it becomes visible all at once.
      const outcome = await runFeedOperation(
        `cubby:activity-photo-add:${activityId}`,
        "/api/feed/posts",
        "POST",
        {
          body: "",
          babyId,
          activityId,
          attachmentIds: [body.data.attachmentId]
        }
      );
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
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
