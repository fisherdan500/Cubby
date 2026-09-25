"use client";

import { useState, type PropsWithChildren } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, PenLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { FEED_POST_MAX_LENGTH, FEED_POST_MAX_PHOTOS } from "@/domain/feed-post";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type OperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };
type Outcome = { ok: true } | { ok: false; message: string };

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

async function operationResponse(response: Response) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: { status?: OperationStatus; operationId?: string };
    error?: { code?: string; message?: string };
  } | null;
  return { response, body, status: body?.ok ? body.data?.status : undefined };
}

/**
 * One feed write - a post, comment or reaction - through a server-issued browser operation: retained
 * for this tab so a retry after a lost response reconciles the same request rather than posting twice,
 * and cleared once it settles. `issueFields` names what the operation binds to when the URL does not.
 */
export async function runFeedOperation(
  storageName: string,
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  fields: Record<string, unknown>,
  issueFields: Record<string, unknown> = {}
): Promise<Outcome> {
  try {
    const { partition } = await householdPartition();
    const storageKey = await tabScopedBrowserOperationStorageKey(partition, `${storageName}:${partition}`);
    const submit = async (operationId: string): Promise<Outcome> => {
      const result = await operationResponse(await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, ...fields })
      }));
      if (isAuthorizedBrowserOperation410(result.response.status, result.body, operationId)) {
        sessionStorage.removeItem(storageKey);
        return { ok: false, message: "This request expired. Try again." };
      }
      if (result.status === "completed") {
        sessionStorage.removeItem(storageKey);
        return { ok: true };
      }
      if (result.status === "pending") return { ok: false, message: "Still saving. Try again in a moment to check." };
      sessionStorage.removeItem(storageKey);
      if (result.status === "stale" || result.status === "rejected") return { ok: false, message: "This changed meanwhile. Refresh and try again." };
      return { ok: false, message: result.body?.error?.message ?? "That did not work. Try again." };
    };

    const retained = sessionStorage.getItem(storageKey);
    if (retained) {
      const reconciled = await operationResponse(await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" }));
      if (reconciled.status === "completed") {
        sessionStorage.removeItem(storageKey);
        return { ok: true };
      }
      if (reconciled.status === "prepared") return submit(retained);
      if (reconciled.status === "pending") return { ok: false, message: "The last request is still saving. Try again in a moment." };
      // Expired, stale or unknown: start afresh.
      sessionStorage.removeItem(storageKey);
    }

    const issued = await operationResponse(await fetch(`${url}?issue=1`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issueFields)
    }));
    const operationId = issued.body?.data?.operationId;
    if (!operationId || (issued.status !== "open" && issued.status !== "prepared")) {
      return { ok: false, message: issued.body?.error?.message ?? "That did not work. Try again." };
    }
    sessionStorage.setItem(storageKey, operationId);
    return submit(operationId);
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }
}

type ChosenPhoto = { attachmentId: string; previewUrl: string };

/** Upload one photo; it stays private and unused until a post claims it. */
async function uploadFeedPhoto(file: File): Promise<{ ok: true; attachmentId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch("/api/attachments/feed-photos", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; data?: { attachmentId?: string }; error?: { message?: string } } | null;
    if (response.ok && body?.ok && body.data?.attachmentId) return { ok: true, attachmentId: body.data.attachmentId };
    return { ok: false, message: body?.error?.message ?? "That photo could not be added. Try again." };
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }
}

/**
 * Write a post for the family feed (DEC-PROD-421): a caption about the baby in view or the whole
 * family, with #tags in the text, and - once photos are switched on - up to ten photos (DEC-PROD-422).
 * Photos upload as soon as they are chosen, so posting is quick. It starts as a quiet prompt so the
 * feed stays the thing you see.
 */
export function FeedPostComposer({ babyId, babyName, photosEnabled = false }: { babyId: string; babyName: string; photosEnabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"baby" | "family">("baby");
  const [photos, setPhotos] = useState<ChosenPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function addPhotos(files: File[]) {
    setError("");
    const room = FEED_POST_MAX_PHOTOS - photos.length;
    const accepted = files.slice(0, room);
    setUploading(true);
    let failure = files.length > room ? `A post can have up to ${FEED_POST_MAX_PHOTOS} photos.` : "";
    for (const file of accepted) {
      const result = await uploadFeedPhoto(file);
      if (result.ok) {
        const photo = { attachmentId: result.attachmentId, previewUrl: URL.createObjectURL(file) };
        setPhotos((current) => [...current, photo]);
      } else {
        failure = result.message;
      }
    }
    setUploading(false);
    if (failure) setError(failure);
  }

  function removePhoto(index: number) {
    setPhotos((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((_, position) => position !== index);
    });
  }

  async function post() {
    if (!body.trim() && photos.length === 0) {
      setError("Write something to share first.");
      return;
    }
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation("cubby:feed-post-create", "/api/feed/posts", "POST", {
      body,
      babyId: scope === "baby" ? babyId : null,
      ...(photos.length ? { attachmentIds: photos.map((photo) => photo.attachmentId) } : {})
    });
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
    setBody("");
    setScope("baby");
    setPhotos([]);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-control bg-card px-4 text-left text-sm text-muted-foreground transition hover:bg-muted"
      >
        <PenLine className="h-4 w-4 text-primary" aria-hidden="true" />
        Share a moment
      </button>
    );
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-card p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        void post();
      }}
    >
      <label className="grid gap-1 text-sm font-semibold">
        What happened?
        <Textarea
          value={body}
          maxLength={FEED_POST_MAX_LENGTH}
          rows={3}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add #tags to find it again later"
        />
      </label>
      {photos.length ? (
        <ul aria-label="Chosen photos" className="grid grid-cols-5 gap-2">
          {photos.map((photo, index) => (
            <li key={photo.attachmentId} className="relative">
              {/* A local preview of the chosen file, before it is shared. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.previewUrl} alt={`Photo ${index + 1}`} className="aspect-square w-full rounded-lg object-cover" />
              <button
                type="button"
                aria-label={`Remove photo ${index + 1}`}
                onClick={() => removePhoto(index)}
                className="absolute -right-1.5 -top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {photosEnabled && photos.length < FEED_POST_MAX_PHOTOS ? (
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-control px-3 text-sm font-semibold hover:bg-muted">
          <ImagePlus className="h-4 w-4 text-primary" aria-hidden="true" />
          {uploading ? "Adding photos..." : "Add photos"}
          <input
            type="file"
            aria-label="Add photos"
            // Only formats Cubby keeps; iPhones hand over a JPEG when HEIC is not offered.
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading || submitting}
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void addPhotos(files);
            }}
          />
        </label>
      ) : null}
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <legend className="sr-only">Who is it about?</legend>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input type="radio" name="feed-post-scope" checked={scope === "baby"} onChange={() => setScope("baby")} />
          About {babyName}
        </label>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input type="radio" name="feed-post-scope" checked={scope === "family"} onChange={() => setScope("family")} />
          The whole family
        </label>
      </fieldset>
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || uploading}>{submitting ? "Posting..." : "Post"}</Button>
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => { setOpen(false); setError(""); }}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * A post's caption, as rendered by the card, with "edited" once it has changed - and, for its author,
 * a way to rewrite it in place. Tags are read again from the new words.
 */
export function FeedPostBody({
  postId,
  body,
  edited,
  canEdit,
  children
}: PropsWithChildren<{
  postId: string;
  body: string;
  edited: boolean;
  canEdit: boolean;
}>) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function save() {
    if (!draft.trim()) {
      setError("Write something to share first.");
      return;
    }
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation(`cubby:feed-post-update:${postId}`, `/api/feed/posts/${encodeURIComponent(postId)}`, "PATCH", { body: draft });
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (editing) {
    return (
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1 text-sm font-semibold">
          <span className="sr-only">Edit your post</span>
          <Textarea value={draft} maxLength={FEED_POST_MAX_LENGTH} rows={3} onChange={(event) => setDraft(event.target.value)} />
        </label>
        {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>{submitting ? "Saving..." : "Save"}</Button>
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => { setEditing(false); setDraft(body); setError(""); }}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-1">
      {body ? <p className="whitespace-pre-line break-words text-sm leading-6">{children}</p> : null}
      {edited || canEdit ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {edited ? <span>edited</span> : null}
          {canEdit ? (
            <button
              type="button"
              aria-label="Edit post"
              onClick={() => { setDraft(body); setEditing(true); }}
              className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold hover:bg-muted hover:text-foreground"
            >
              Edit
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Bring back a post removed in the last thirty days, with its photos. */
export function FeedPostRestoreButton({ postId }: { postId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function restore() {
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation(`cubby:feed-post-restore:${postId}`, `/api/feed/posts/${encodeURIComponent(postId)}/restore`, "POST", {});
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" disabled={submitting} onClick={() => void restore()}>
        {submitting ? "Restoring..." : "Restore"}
      </Button>
      {error ? <p role="alert" className="w-full text-xs font-semibold text-danger">{error}</p> : null}
    </div>
  );
}

/** Remove a post, after an explicit second step. Shown only to those who may remove it. */
export function FeedPostRemoveButton({ postId }: { postId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function remove() {
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation(`cubby:feed-post-delete:${postId}`, `/api/feed/posts/${encodeURIComponent(postId)}`, "DELETE", {});
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label="Remove post"
        onClick={() => setConfirming(true)}
        className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-danger"
      >
        Remove
      </button>
    );
  }

  return (
    <div role="group" aria-label="Confirm removing this post" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-danger">Remove this post?</span>
      <Button type="button" variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>Keep</Button>
      <Button type="button" variant="danger" disabled={submitting} onClick={() => void remove()}>{submitting ? "Removing..." : "Remove"}</Button>
      {error ? <p role="alert" className="w-full text-xs font-semibold text-danger">{error}</p> : null}
    </div>
  );
}
