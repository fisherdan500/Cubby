"use client";

import { useRef, useState } from "react";
import { AlertTriangle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HouseholdLeaveWarning } from "@/server/services/household-leave";

type LeavePreview = {
  householdId: string;
  householdName: string;
  membershipId: string;
  role: "owner" | "admin" | "parent" | "caretaker" | "read_only";
  suspended: boolean;
  protectedOwner: boolean;
  authorityImpact: { apiKeysToRevoke: number; webhooksToRetire: number };
  warnings: readonly HouseholdLeaveWarning[];
};

const warningText: Record<HouseholdLeaveWarning, (impact: LeavePreview["authorityImpact"]) => string> = {
  sole_admin: () => "You are the only remaining administrator. The owner will need to appoint another administrator if needed.",
  active_timers: () => "Running or paused timers you started remain household records, but you will no longer be able to manage them.",
  pending_invitations: () => "Pending invitations you issued or received for this household will be revoked.",
  notification_authority: () => "Your browser notification preferences and subscriptions for this household will be removed.",
  api_key_authority: (impact) => `${impact.apiKeysToRevoke} API key${impact.apiKeysToRevoke === 1 ? "" : "s"} will be revoked. Key values are never shown here.`,
  webhook_authority: (impact) => `${impact.webhooksToRetire} webhook${impact.webhooksToRetire === 1 ? "" : "s"} will be disabled and queued deliveries will be stopped. Endpoint addresses are never shown here.`
};

type LeaveSubmissionState = { busy: boolean };
type OperationStorage = Pick<Storage, "getItem" | "setItem">;

export function beginLeaveSubmission(
  state: LeaveSubmissionState,
  membershipId: string,
  storage: OperationStorage,
  create: () => string = () => crypto.randomUUID()
) {
  if (state.busy) return null;
  state.busy = true;
  const key = `cubby.household-leave-operation:${membershipId}`;
  const operationId = storage.getItem(key) ?? create();
  storage.setItem(key, operationId);
  return operationId;
}

export function finishLeaveSubmission(state: LeaveSubmissionState) {
  state.busy = false;
}

export function LeaveHouseholdForm({ preview }: { preview: LeavePreview }) {
  const submission = useRef<LeaveSubmissionState>({ busy: false });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (preview.protectedOwner) {
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
        <p className="font-semibold text-danger">The protected household owner cannot leave.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          You must transfer ownership before leaving. Ownership transfer is not available in this milestone.
        </p>
      </div>
    );
  }

  async function submit(formData: FormData) {
    const operationId = beginLeaveSubmission(
      submission.current,
      preview.membershipId,
      window.sessionStorage
    );
    if (!operationId) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/households/leave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: preview.householdId,
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
      window.location.assign("/app");
    } catch {
      setMessage("The result is unknown. Retry this form to reconcile the same leave operation.");
    } finally {
      finishLeaveSubmission(submission.current);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" />
          <div className="space-y-2 text-sm">
            <p className="font-semibold">Leaving takes effect immediately.</p>
            <p>
              Your membership episode closes with a self-left reason. Household records and your historical attribution remain unchanged.
            </p>
            <p>
              Returning requires a new invitation and will not restore your old role, sessions, notifications, or other authority.
            </p>
          </div>
        </div>
      </div>

      {preview.warnings.length > 0 ? (
        <section aria-labelledby="leave-warnings" className="space-y-2">
          <h2 id="leave-warnings" className="font-bold">Review before leaving</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {preview.warnings.map((warning) => <li key={warning}>{warningText[warning](preview.authorityImpact)}</li>)}
          </ul>
        </section>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <label className="block space-y-1 text-sm font-semibold">
          <span>Type the household name exactly: {preview.householdName}</span>
          <Input name="confirmation" autoComplete="off" required />
        </label>
        <p className="text-xs text-muted-foreground">
          Sign in again first if your current authentication is more than ten minutes old.
        </p>
        {message ? <p role="alert" className="text-sm font-semibold text-danger">{message}</p> : null}
        <Button type="submit" variant="danger" disabled={busy}>
          <LogOut className="h-4 w-4" />
          {busy ? "Leaving..." : "Leave household"}
        </Button>
      </form>
    </div>
  );
}
