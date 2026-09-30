"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { babyDeleteConfirmationPhrase } from "@/lib/validation/onboarding";

/**
 * Deleting a baby. Two outcomes, and which one is offered is the server's decision, not this
 * component's: `canRemove` reflects a reference count taken on the server.
 *
 * The typed phrase is checked here only so the button can stay disabled. The server checks it again
 * against the name it reads from the database, which is the check that actually protects anything.
 */
export function BabyDeleteDialog({
  babyId,
  babyName,
  canRemove
}: {
  babyId: string;
  babyName: string;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const phrase = babyDeleteConfirmationPhrase(babyName);
  const matches = typed === phrase;

  async function submit() {
    if (!matches) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch(`/api/babies/${babyId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: typed, mode: canRemove ? "remove" : "hide" })
      });
      const result = await response.json().catch(() => null) as
        | { ok: true }
        | { ok: false; error?: { code?: string } }
        | null;
      if (!response.ok || !result?.ok) {
        // The envelope carries the machine token in `code`; `message` is the human sentence, which
        // never equals the token. Reading `message` here made every branch below dead code.
        const code = result && !result.ok ? result.error?.code : undefined;
        setError(
          code === "baby_has_history"
            ? "This baby now has history, so it can no longer be removed outright. Close this and try again to hide it instead."
            : code === "confirmation_mismatch"
              ? "That phrase does not match."
              : code === "baby_has_active_timer"
                ? "Stop this baby's running timer first."
                : "Could not delete this baby."
        );
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Try again.");
    } finally {
      setWorking(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="min-h-11" onClick={() => setOpen(true)}>
        Delete...
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-danger/40 p-3">
      <p className="text-sm font-bold">
        {canRemove ? `Remove ${babyName}?` : `Delete ${babyName} and everything recorded for them?`}
      </p>
      <p className="text-sm text-muted-foreground">
        {canRemove
          ? "This profile has no history, so it will be removed completely. This cannot be undone."
          : "This baby and all of their entries and photos will disappear from Cubby. Nothing is erased, so a backup taken before now can still restore them."}
      </p>
      <div>
        <label className="text-sm" htmlFor={`delete-confirm-${babyId}`}>
          Type <span className="font-bold">{phrase}</span> to confirm
        </label>
        <Input
          id={`delete-confirm-${babyId}`}
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" variant="danger" disabled={!matches || working} onClick={submit}>
          {working ? "Deleting..." : canRemove ? "Remove profile" : "Delete baby"}
        </Button>
        <Button type="button" variant="secondary" disabled={working} onClick={() => { setOpen(false); setTyped(""); setError(""); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
