"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { activityDeleteError } from "@/lib/activity-delete";

export function ConfirmedActivityDelete({ id, returnTo }: { id: string; returnTo: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const hasOpened = useRef(false);
  const triggerContainer = useRef<HTMLDivElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const mutationId = useRef<string>();

  useEffect(() => {
    if (confirming) confirmationHeading.current?.focus();
    else if (hasOpened.current) triggerContainer.current?.querySelector("button")?.focus();
  }, [confirming]);

  async function remove() {
    setSubmitting(true);
    setError("");

    try {
      mutationId.current ??= crypto.randomUUID();
      const response = await fetch(`/api/activities/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMutationId: mutationId.current })
      });
      const result = await response.json().catch(() => null);
      const message = activityDeleteError(response.ok, result);
      if (message) {
        setError(message);
        return;
      }
      mutationId.current = undefined;
      router.replace(returnTo);
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!confirming) {
    return (
      <div ref={triggerContainer} className="border-t border-danger/25 pt-5">
        <Button
          type="button"
          variant="ghost"
          className="w-full text-danger hover:bg-danger/10 sm:w-auto"
          onClick={() => {
            hasOpened.current = true;
            setConfirming(true);
          }}
        >
          Delete activity
        </Button>
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-danger/40 bg-danger/5 p-4" aria-label="Confirm activity deletion">
      <div>
        <h2 ref={confirmationHeading} tabIndex={-1} className="font-black text-danger">Delete this activity?</h2>
        <p className="mt-1 text-sm text-muted-foreground">This cannot be undone.</p>
      </div>
      {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button type="button" variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>
          Keep activity
        </Button>
        <Button type="button" variant="danger" disabled={submitting} onClick={remove}>
          {submitting ? "Deleting..." : "Delete activity"}
        </Button>
      </div>
    </section>
  );
}
