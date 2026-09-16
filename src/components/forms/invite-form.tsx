"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type InviteOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };

function inviteStorageKey(partition: string) {
  return `cubby:invite-create-operation:${partition}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}
type InviteOperationResult = {
  status: InviteOperationStatus;
  operationId: string;
  outcome?: { acceptUrl?: string };
};



async function inviteOperationResponse(response: Response) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: InviteOperationResult;
    error?: { message?: string };
  } | null;
  return { response, body, result: body?.ok ? body.data : undefined };
}

export function InviteForm({ canInviteAdmin }: { canInviteAdmin: boolean }) {
  const router = useRouter();
  const [acceptUrl, setAcceptUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function clearOperation(storageKey: string) {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Storage failure must not affect the terminal server outcome.
    }
  }

  async function submit(formData: FormData) {
    setError("");
    setAcceptUrl("");
    setSubmitting(true);
    let currentOperationId: string | undefined;
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, inviteStorageKey(partition));
      currentOperationId = sessionStorage.getItem(storageKey) ?? undefined;
      if (currentOperationId) {
        const reconciled = await inviteOperationResponse(await fetch(`/api/browser-operations/${currentOperationId}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(reconciled.response.status, reconciled.result, currentOperationId)) {
          clearOperation(storageKey);
          currentOperationId = undefined;
        } else if (reconciled.result?.status === "completed") {
          clearOperation(storageKey);
          setError("Invite created, but its display-once link is no longer available. Create a replacement only if you need a new link.");
          router.refresh();
          return;
        } else if (reconciled.result?.status === "prepared") {
          // Submit the retained reservation below with the unchanged operation ID.
        } else if (reconciled.result?.status === "pending") {
          setError("This invitation request is still in progress. Reconcile it before changing it again.");
          return;
        } else if (reconciled.result?.status === "stale" || reconciled.result?.status === "rejected") {
          setError("This invitation request is no longer current. Refresh before trying again.");
          return;
        } else {
          setError("Reconcile this invitation request before trying again.");
          return;
        }
      }

      const input = Object.fromEntries(formData);
      if (!currentOperationId) {
        const issued = await inviteOperationResponse(await fetch("/api/invites?issue=1", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
        }));
        if (!issued.response.ok || !issued.result?.operationId || (issued.result.status !== "open" && issued.result.status !== "prepared")) {
          throw new Error("invite_operation_issue_unavailable");
        }
        currentOperationId = issued.result.operationId;
        sessionStorage.setItem(storageKey, currentOperationId);
      }
      const submitted = await inviteOperationResponse(await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, operationId: currentOperationId })
      }));
      if (isAuthorizedBrowserOperation410(submitted.response.status, submitted.result, currentOperationId)) {
        clearOperation(storageKey);
        setError("This invitation request expired. Submit again to open a new request.");
        return;
      }
      if (submitted.result?.status === "completed") {
        const displayOnceUrl = submitted.result.outcome?.acceptUrl;
        clearOperation(storageKey);
        if (displayOnceUrl) setAcceptUrl(`${window.location.origin}${displayOnceUrl}`);
        else setError("Invite created, but its display-once link is no longer available. Create a replacement only if you need a new link.");
        router.refresh();
        return;
      }
      if (submitted.result?.status === "pending") {
        setError("This invitation request is still in progress. Reconcile it before changing it again.");
        return;
      }
      if (submitted.result?.status === "stale" || submitted.result?.status === "rejected") {
        setError("This invitation request is no longer current. Refresh before trying again.");
        return;
      }
      setError(submitted.body?.error?.message ?? "Reconcile this invitation request before trying again.");
    } catch {
      setError("Reconcile this invitation request before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={submit} className="min-w-0 space-y-3">
      <label className="sr-only" htmlFor="invite-email">Email</label>
      <Input id="invite-email" name="email" type="email" placeholder="caretaker@example.com" required />
      <label className="sr-only" htmlFor="invite-role">Role</label>
      <Select id="invite-role" name="role">
        <option value="caretaker">Caretaker</option>
        <option value="parent">Parent</option>
        <option value="read_only">Read only</option>
        {canInviteAdmin ? <option value="admin">Admin</option> : null}
      </Select>
      <label className="sr-only" htmlFor="invite-expiry">Invitation expiry</label>
      <Select id="invite-expiry" name="expiresInHours" defaultValue="">
        <option value="">Default expiry</option>
        <option value="1">1 hour</option>
        <option value="24">1 day</option>
        <option value="168">7 days</option>
      </Select>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {acceptUrl ? (
        <div className="rounded-lg bg-muted p-3 text-sm">
          <p className="font-semibold">Invite link</p>
          <p className="break-all text-muted-foreground">{acceptUrl}</p>
          <p className="mt-2 text-xs font-semibold text-muted-foreground">
            Copy this link now. Cubby displays the raw invitation link only once, and issuing another invite for this email revokes earlier pending links.
          </p>
        </div>
      ) : null}
      <Button disabled={submitting}>{submitting ? "Inviting..." : "Invite member"}</Button>
    </form>
  );
}
