"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Result = { ok: true; attachmentId: string } | { ok: false; message: string };

async function readMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as
    { ok?: boolean; data?: { attachmentId?: string }; error?: { message?: string } } | null;
  return { body, message: body?.error?.message ?? fallback };
}

/**
 * Upload a picture, then make it the baby's.
 *
 * Two steps, in this order, because the upload stays private until something claims it: a picture
 * that fails to upload must not be claimed, or the family would see an error about the wrong step
 * and a meaningless id would reach the server.
 *
 * Exported separately from the control so the sequence can be tested without a DOM.
 */
export async function uploadAndClaimBabyPhoto(babyId: string, file: File): Promise<Result> {
  let attachmentId: string;
  try {
    const upload = await fetch("/api/attachments/baby-photos", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file
    });
    const { body, message } = await readMessage(upload, "That picture could not be added. Try again.");
    if (!upload.ok || !body?.ok || !body.data?.attachmentId) return { ok: false, message };
    attachmentId = body.data.attachmentId;
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }

  try {
    const claim = await fetch(`/api/babies/${babyId}/photo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId })
    });
    const { body, message } = await readMessage(claim, "That picture could not be used. Try again.");
    if (!claim.ok || !body?.ok) return { ok: false, message };
    return { ok: true, attachmentId };
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }
}

/**
 * Show a baby's picture and let someone with baby.manage change it.
 *
 * Choosing a file uploads and claims immediately, so there is no separate save step to forget. The
 * page is refreshed afterwards rather than the new id being held locally, so what is shown is what
 * the server would serve on a reload.
 */
export function BabyPhotoControl({
  babyId,
  babyName,
  photoAttachmentId
}: {
  babyId: string;
  babyName: string;
  photoAttachmentId: string | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const result = await uploadAndClaimBabyPhoto(babyId, file);
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      {photoAttachmentId
        ? (
          // eslint-disable-next-line @next/next/no-img-element -- served privately by our own route, not an optimisable static asset
          <img
            src={`/api/attachments/${photoAttachmentId}?size=thumbnail`}
            alt={`${babyName}'s picture`}
            className="h-12 w-12 rounded-full object-cover"
          />
        )
        : (
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500"
          >
            {babyName.slice(0, 1).toUpperCase()}
          </span>
        )}
      <div className="space-y-1">
        <label className="cursor-pointer text-sm text-sky-700 hover:underline">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          {busy ? "Adding…" : photoAttachmentId ? "Change picture" : "Add a picture"}
        </label>
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
      </div>
    </div>
  );
}
