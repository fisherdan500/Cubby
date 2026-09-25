"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { FEED_POST_MAX_LENGTH } from "@/domain/feed-post";
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
 * One feed write through a server-issued browser operation: retained for this tab so a retry after a
 * lost response reconciles the same request rather than posting twice, and cleared once it settles.
 */
async function runFeedOperation(storageName: string, url: string, method: "POST" | "DELETE", fields: Record<string, unknown>): Promise<Outcome> {
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
      body: JSON.stringify({})
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

/**
 * Write a post for the family feed (DEC-PROD-421): a caption about the baby in view or the whole
 * family, with #tags in the text. It starts as a quiet prompt so the feed stays the thing you see.
 */
export function FeedPostComposer({ babyId, babyName }: { babyId: string; babyName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"baby" | "family">("baby");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function post() {
    if (!body.trim()) {
      setError("Write something to share first.");
      return;
    }
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation("cubby:feed-post-create", "/api/feed/posts", "POST", {
      body,
      babyId: scope === "baby" ? babyId : null
    });
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setBody("");
    setScope("baby");
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
        <Button type="submit" disabled={submitting}>{submitting ? "Posting..." : "Post"}</Button>
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => { setOpen(false); setError(""); }}>Cancel</Button>
      </div>
    </form>
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
