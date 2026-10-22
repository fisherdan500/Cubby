"use client";

import { useRef, useState } from "react";
import { ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Recipient = {
  memberId: string;
  displayName: string | null;
  email: string | null;
  role: string;
};

type PendingTransfer = {
  transferId: string;
  householdId: string;
  recipientName: string | null;
  expiresAt: string;
};

type SubmissionState = { busy: boolean };
type OperationStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * One operation id per household for the owner's initiation, held in sessionStorage.
 *
 * A lost response must not create two pending transfers. Reusing the same id means a retry
 * reconciles the original request instead of starting a second one.
 */
export function beginTransferSubmission(
  state: SubmissionState,
  scopeId: string,
  storage: OperationStorage,
  create: () => string = () => crypto.randomUUID()
) {
  if (state.busy) return null;
  state.busy = true;
  const key = `cubby.household-ownership-transfer-operation:${scopeId}`;
  const operationId = storage.getItem(key) ?? create();
  storage.setItem(key, operationId);
  return operationId;
}

export function finishTransferSubmission(state: SubmissionState) {
  state.busy = false;
}

function recipientLabel(recipient: Recipient) {
  return recipient.displayName ?? recipient.email ?? recipient.memberId;
}

/**
 * The owner names a successor.
 *
 * Nothing moves when this is submitted: it records a pending transfer the recipient must accept.
 * The form says so plainly, because "transfer ownership" sounds immediate and is not.
 */
export function OwnershipTransferForm({
  householdId,
  householdName,
  recipients,
  pending
}: {
  householdId: string;
  householdName: string;
  recipients: readonly Recipient[];
  pending: PendingTransfer | null;
}) {
  const submission = useRef<SubmissionState>({ busy: false });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (pending) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
        <p className="font-semibold">
          Waiting for {pending.recipientName ?? "the chosen member"} to accept.
        </p>
        <p className="mt-2 text-muted-foreground">
          You are still the owner until they accept. Nothing has changed yet.
        </p>
      </div>
    );
  }

  if (recipients.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm">
        <p className="font-semibold">There is nobody who can receive this household yet.</p>
        <p className="mt-2 text-muted-foreground">
          Ownership can only go to an active member with a verified account. Invite them first and
          wait for them to accept, then come back here.
        </p>
      </div>
    );
  }

  async function submit(formData: FormData) {
    const operationId = beginTransferSubmission(
      submission.current,
      householdId,
      window.sessionStorage
    );
    if (!operationId) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/households/ownership-transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          toMemberId: formData.get("toMemberId"),
          confirmation: formData.get("confirmation"),
          operationId
        })
      });
      const result = await response.json();
      if (!result.ok) {
        setMessage(
          result.error.code === "fresh_authentication_required"
            ? "Sign in again, return here, and retry with the same confirmation."
            : result.error.message
        );
        return;
      }
      window.location.reload();
    } catch {
      setMessage("The result is unknown. Retry this form to reconcile the same transfer request.");
    } finally {
      finishTransferSubmission(submission.current);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" />
          <div className="space-y-2 text-sm">
            <p className="font-semibold">You will become an administrator.</p>
            <p>
              The member you choose becomes the household owner once they accept. You keep your
              place in the household as an administrator, and the new owner can change that
              afterwards.
            </p>
            <p>Nothing changes until they accept. You can still use the household normally.</p>
          </div>
        </div>
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <label className="block space-y-1 text-sm font-semibold">
          <span>Who should own {householdName}?</span>
          <select
            name="toMemberId"
            required
            className="w-full rounded-lg border border-control bg-background p-2 text-sm font-normal"
          >
            {recipients.map((recipient) => (
              <option key={recipient.memberId} value={recipient.memberId}>
                {recipientLabel(recipient)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm font-semibold">
          <span>Type the household name exactly: {householdName}</span>
          <Input name="confirmation" autoComplete="off" required />
        </label>
        <p className="text-xs text-muted-foreground">
          Sign in again first if your current authentication is more than ten minutes old.
        </p>
        {message ? <p role="alert" className="text-sm font-semibold text-danger">{message}</p> : null}
        <Button type="submit" disabled={busy}>
          <UserCheck className="h-4 w-4" />
          {busy ? "Offering..." : "Offer ownership"}
        </Button>
      </form>
    </div>
  );
}

/**
 * The recipient's side: accept and become the owner, or decline and change nothing.
 *
 * Decline is not a destructive action and is not styled as one -- it simply ends the offer.
 */
export function OwnershipTransferAnswerForm({
  householdId,
  householdName,
  transferId,
  offeredBy
}: {
  householdId: string;
  householdName: string;
  transferId: string;
  offeredBy: string | null;
}) {
  const submission = useRef<SubmissionState>({ busy: false });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function answer(choice: "accept" | "decline") {
    const operationId = beginTransferSubmission(
      submission.current,
      `${transferId}:${choice}`,
      window.sessionStorage
    );
    if (!operationId) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/households/ownership-transfer/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: choice, householdId, transferId, operationId })
      });
      const result = await response.json();
      if (!result.ok) {
        setMessage(
          result.error.code === "fresh_authentication_required"
            ? "Sign in again, return here, and answer once more."
            : result.error.message
        );
        return;
      }
      window.location.assign("/app/settings");
    } catch {
      setMessage("The result is unknown. Answer again to reconcile the same request.");
    } finally {
      finishTransferSubmission(submission.current);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
        <p className="font-semibold">
          {offeredBy ?? "The current owner"} offered you ownership of {householdName}.
        </p>
        <p className="mt-2 text-muted-foreground">
          Accepting makes you the household owner. The current owner stays in the household as an
          administrator. Declining changes nothing.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Sign in again first if your current authentication is more than ten minutes old.
      </p>
      {message ? <p role="alert" className="text-sm font-semibold text-danger">{message}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={busy} onClick={() => void answer("accept")}>
          <UserCheck className="h-4 w-4" />
          {busy ? "Working..." : "Accept ownership"}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void answer("decline")}>
          Decline
        </Button>
      </div>
    </div>
  );
}
