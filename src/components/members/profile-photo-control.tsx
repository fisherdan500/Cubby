"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { MemberAvatar } from "@/components/members/member-avatar";

type Result = { ok: true; attachmentId: string } | { ok: false; message: string };

async function readMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: { attachmentId?: string }; error?: { message?: string } }
    | null;
  return { body, message: body?.error?.message ?? fallback };
}

/**
 * Upload a picture, then make it your own.
 *
 * Two steps, in this order, because the upload stays private until something claims it: a picture
 * that fails to upload must not be claimed, or the member sees an error about the wrong step and a
 * meaningless id reaches the server. There is no member id in the claim -- a member sets their own
 * picture and nobody else's.
 *
 * Exported separately from the control so the sequence can be tested without a DOM.
 */
export async function uploadAndClaimOwnPhoto(file: File): Promise<Result> {
  let attachmentId: string;
  try {
    const upload = await fetch("/api/attachments/user-photos", {
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
    const claim = await fetch("/api/members/me/photo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId })
    });
    const { body, message } = await readMessage(claim, "That picture could not be saved. Try again.");
    if (!claim.ok || !body?.ok) return { ok: false, message };
    return { ok: true, attachmentId };
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }
}

/** Your own picture, with the one control that changes it. */
export function ProfilePhotoControl({
  name,
  photoAttachmentId
}: {
  name: string;
  photoAttachmentId: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const result = await uploadAndClaimOwnPhoto(file);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <MemberAvatar name={name} photoAttachmentId={photoAttachmentId} size="lg" />
      <div className="space-y-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex min-h-11 items-center rounded-lg border border-control bg-card px-3 text-sm font-semibold hover:bg-muted disabled:opacity-60"
        >
          {busy ? "Adding…" : photoAttachmentId ? "Change your picture" : "Add your picture"}
        </button>
        {error ? (
          <p role="alert" className="text-xs font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label="Your picture"
        onChange={(event) => void choose(event.target.files?.[0])}
      />
    </div>
  );
}
