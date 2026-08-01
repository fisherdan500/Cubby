"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type RegistrationIntent = {
  householdCreationMode: "closed" | "invitation_only" | "open";
  allowPublicRegistration: boolean;
};

type RegistrationPendingOperation = { operationId: string; intent: RegistrationIntent };
type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const registrationPendingOperationStorageKey = "cubby.platform-registration.pending-operation";

function isRegistrationIntent(value: unknown): value is RegistrationIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  return (
    (intent.householdCreationMode === "closed" ||
      intent.householdCreationMode === "invitation_only" ||
      intent.householdCreationMode === "open") &&
    typeof intent.allowPublicRegistration === "boolean"
  );
}

export function readRegistrationPendingOperation(storage: SessionStorageLike): RegistrationPendingOperation | null {
  const serialized = storage.getItem(registrationPendingOperationStorageKey);
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (typeof value.operationId === "string" && isRegistrationIntent(value.intent)) {
      return { operationId: value.operationId, intent: value.intent };
    }
  } catch {
    // Browser storage is untrusted; discard malformed state rather than issuing a new mutation from it.
  }
  storage.removeItem(registrationPendingOperationStorageKey);
  return null;
}

export function registrationDraftForStorage(storage: SessionStorageLike, fallback: RegistrationIntent) {
  return readRegistrationPendingOperation(storage)?.intent ?? fallback;
}

export function storeRegistrationPendingOperation(storage: SessionStorageLike, operation: RegistrationPendingOperation) {
  storage.setItem(registrationPendingOperationStorageKey, JSON.stringify(operation));
}

export function clearRegistrationPendingOperation(storage: SessionStorageLike) {
  storage.removeItem(registrationPendingOperationStorageKey);
}

export function registrationIntentMatches(stored: RegistrationIntent | undefined, intent: RegistrationIntent) {
  return (
    stored?.householdCreationMode === intent.householdCreationMode &&
    stored.allowPublicRegistration === intent.allowPublicRegistration
  );
}

export function RegistrationSettingsForm({
  householdCreationMode,
  allowPublicRegistration,
}: {
  householdCreationMode: "closed" | "invitation_only" | "open";
  allowPublicRegistration: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<RegistrationIntent>({ householdCreationMode, allowPublicRegistration });

  useEffect(() => {
    setDraft(registrationDraftForStorage(window.sessionStorage, { householdCreationMode, allowPublicRegistration }));
  }, [householdCreationMode, allowPublicRegistration]);

  async function submit(_formData: FormData) {
    setError("");
    setSaving(true);
    const storage = window.sessionStorage;
    const intent = draft;

    async function reconcile(operationId: string) {
      try {
        const response = await fetch(
          `/api/platform/registration?operationId=${encodeURIComponent(operationId)}`
        );
        if (!response.ok) return "unavailable" as const;
        const status = await response.json();
        if (status.data?.status === "completed") {
          clearRegistrationPendingOperation(storage);
          router.refresh();
          return "completed" as const;
        }
        if (status.data?.status === "stale") {
          clearRegistrationPendingOperation(storage);
          setError("Registration policy changed before this save could be completed. Refresh and try again.");
          return "stale" as const;
        }
        return "pending" as const;
      } catch {
        return "unavailable" as const;
      }
    }

    try {
      const prior = readRegistrationPendingOperation(storage);
      let operationId: string | undefined;
      if (prior) {
        const reconciliation = await reconcile(prior.operationId);
        if (reconciliation === "completed" || reconciliation === "stale") return;
        if (registrationIntentMatches(prior.intent, intent)) operationId = prior.operationId;
        else clearRegistrationPendingOperation(storage);
      }

      if (!operationId) {
        const allocationResponse = await fetch("/api/platform/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intent)
        });
        const allocation = await allocationResponse.json();
        if (!allocation.ok || typeof allocation.data?.operationId !== "string") {
          setError(
            typeof allocation.error?.message === "string" ? allocation.error.message : "Unable to save policy."
          );
          return;
        }
        const allocatedOperationId = allocation.data.operationId;
        operationId = allocatedOperationId;
        storeRegistrationPendingOperation(storage, { operationId: allocatedOperationId, intent });
      }

      if (!operationId) throw new Error("operation_allocation_missing_id");

      const response = await fetch("/api/platform/registration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId })
      });
      const result = await response.json();
      if (!result.ok) {
        const reconciliation = await reconcile(operationId);
        if (reconciliation === "completed" || reconciliation === "stale") return;
        setError(
          typeof result.error?.message === "string" ? result.error.message : "Unable to save policy."
        );
        return;
      }
      clearRegistrationPendingOperation(storage);
      router.refresh();
    } catch {
      const prior = readRegistrationPendingOperation(storage);
      if (prior) {
        const reconciliation = await reconcile(prior.operationId);
        if (reconciliation === "completed" || reconciliation === "stale") return;
      }
      setError("Unable to save policy. Retry to reconcile the saved operation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form action={submit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-bold">Household creation</legend>
        <p className="text-sm text-muted-foreground">
          This policy applies to verified accounts without a household. Existing household invitations remain separate.
        </p>
        {[
          ["closed", "Closed", "No direct household creation."],
          [
            "invitation_only",
            "Invitation only",
            "Direct creation stays blocked. Creation-invitation issuance is delivered in a later slice."
          ],
          ["open", "Open", "Verified accounts without a household may create one."]
        ].map(([value, label, description]) => (
          <label key={value} className="flex items-start gap-3 rounded-md bg-muted p-3">
            <input
              name="householdCreationMode"
              type="radio"
              value={value}
              checked={draft.householdCreationMode === value}
              onChange={() =>
                setDraft((current) => ({
                  ...current,
                  householdCreationMode: value as RegistrationIntent["householdCreationMode"]
                }))
              }
              className="mt-1"
            />
            <span>
              <span className="block font-bold">{label}</span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-3 rounded-md bg-muted p-3">
        <input
          name="allowPublicRegistration"
          type="checkbox"
          checked={draft.allowPublicRegistration}
          onChange={(event) => setDraft((current) => ({ ...current, allowPublicRegistration: event.target.checked }))}
          className="mt-1"
        />
        <span>
          <span className="block font-bold">Public account creation</span>
          <span className="text-sm text-muted-foreground">
            Allow normal create-account signups. This does not grant household creation.
          </span>
        </span>
      </label>
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button disabled={saving}>{saving ? "Saving…" : "Save registration policy"}</Button>
    </form>
  );
}
