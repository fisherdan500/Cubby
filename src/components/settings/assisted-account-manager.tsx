"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  assignableHouseholdRoles,
  canAssignHouseholdRole,
  householdRoleDetails,
  type HouseholdRoleName
} from "@/domain/roles";

type AssistedMember = {
  id: string;
  name: string;
  email: string;
  role: HouseholdRoleName;
  disabledAt: string | null;
};

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function assistedOperationId() {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

async function assistedPost(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null) as
    { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } | null;
  if (!response.ok || body?.ok !== true || !body.data) {
    throw new Error(body?.error?.message ?? "That request could not be completed.");
  }
  return body.data as { status: string; code?: string; openingFingerprint?: string; outcome?: Record<string, unknown> };
}

function describeOutcome(result: { status: string; code?: string }) {
  if (result.status === "completed") return null;
  if (result.code === "existing_account_invitation_required") {
    return "Someone already uses that email address. Invite them instead.";
  }
  if (result.code === "personal_recovery_unavailable") {
    return "This person also belongs to another household, so their password can only be reset by them from their own email recovery.";
  }
  if (result.status === "expired") return "That request expired. Try again.";
  if (result.status === "pending") return "That request is still finishing. Check again in a moment.";
  return "Something changed while saving. Refresh and try again.";
}

/**
 * Admin-assisted account creation and password reset. Every authority decision is re-made on the
 * server; these controls only hide what the server would refuse anyway.
 */
export function AssistedAccountManager({
  members,
  viewerRole
}: {
  members: AssistedMember[];
  viewerRole: HouseholdRoleName;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);

  const creatableRoles = assignableHouseholdRoles.filter((role) => canAssignHouseholdRole(viewerRole, role));
  const resettable = members.filter((member) =>
    member.role !== "owner" && canAssignHouseholdRole(viewerRole, member.role));

  async function createAccount(form: FormData) {
    setMessage("");
    setNotice("");
    setBusy(true);
    try {
      const operationId = assistedOperationId();
      const opened = await assistedPost("/api/members/assisted-account?issue=1", { operationId });
      if (opened.status !== "open" || typeof opened.openingFingerprint !== "string") {
        setMessage(describeOutcome(opened) ?? "That account could not be created.");
        return;
      }
      const result = await assistedPost("/api/members/assisted-account", {
        operationId,
        openingFingerprint: opened.openingFingerprint,
        name: String(form.get("name") ?? ""),
        email: String(form.get("email") ?? ""),
        role: String(form.get("role") ?? "parent"),
        password: String(form.get("password") ?? ""),
        passwordConfirmation: String(form.get("passwordConfirmation") ?? ""),
        requireFirstLoginPasswordChange: form.get("requireFirstLoginPasswordChange") === "on"
      });
      const problem = describeOutcome(result);
      if (problem) {
        setMessage(problem);
        return;
      }
      setNotice("Account created. Give them the password you just chose so they can sign in.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That account could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(memberId: string, form: FormData) {
    setMessage("");
    setNotice("");
    setBusy(true);
    try {
      const operationId = assistedOperationId();
      const opened = await assistedPost(`/api/members/${encodeURIComponent(memberId)}/assisted-password?issue=1`, { operationId });
      if (opened.status !== "open" || typeof opened.openingFingerprint !== "string") {
        setMessage(describeOutcome(opened) ?? "That password could not be reset.");
        return;
      }
      const snapshot = opened as unknown as {
        snapshot?: { targetUserId?: string; credentialVersion?: number; sessionSecurityVersion?: number };
      };
      const result = await assistedPost(`/api/members/${encodeURIComponent(memberId)}/assisted-password`, {
        operationId,
        openingFingerprint: opened.openingFingerprint,
        targetUserId: snapshot.snapshot?.targetUserId,
        credentialVersion: snapshot.snapshot?.credentialVersion,
        sessionSecurityVersion: snapshot.snapshot?.sessionSecurityVersion,
        password: String(form.get("password") ?? ""),
        passwordConfirmation: String(form.get("passwordConfirmation") ?? ""),
        requireFirstLoginPasswordChange: form.get("requireFirstLoginPasswordChange") === "on"
      });
      const problem = describeOutcome(result);
      if (problem) {
        setMessage(problem);
        return;
      }
      setNotice("Password reset. Give them the new password so they can sign in.");
      setResetFor(null);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That password could not be reset.");
    } finally {
      setBusy(false);
    }
  }

  if (creatableRoles.length === 0) return null;

  return (
    <div className="space-y-5">
      {message ? <p role="alert" className="rounded-md bg-danger/10 p-3 text-sm font-semibold text-danger">{message}</p> : null}
      {notice ? <p className="rounded-md bg-success/10 p-3 text-sm font-semibold text-success">{notice}</p> : null}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <UserRoundPlus className="h-5 w-5" />
          Create an account
        </h2>
        <p className="text-sm text-muted-foreground">
          Set someone up directly by choosing their name, email and a starting password.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createAccount(new FormData(event.currentTarget));
          }}
        >
          <Input name="name" placeholder="Full name" aria-label="Full name" required maxLength={191} />
          <Input name="email" type="email" placeholder="Email address" aria-label="Email address" required />
          <select
            name="role"
            defaultValue="parent"
            aria-label="Role"
            className="min-h-11 w-full rounded-lg border border-control bg-card px-3 py-2 text-sm"
          >
            {creatableRoles.map((role) => (
              <option key={role} value={role}>{householdRoleDetails[role].label}</option>
            ))}
          </select>
          <Input name="password" type="password" placeholder="Starting password" aria-label="Starting password" required minLength={8} />
          <Input name="passwordConfirmation" type="password" placeholder="Confirm password" aria-label="Confirm password" required minLength={8} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="requireFirstLoginPasswordChange" className="mt-1 h-4 w-4" />
            <span>Require this person to choose their own password the first time they sign in</span>
          </label>
          <Button type="submit" disabled={busy}>{busy ? "Working…" : "Create account"}</Button>
        </form>
      </section>

      {resettable.length > 0 ? (
        <section className="space-y-3 border-t border-border pt-5">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <KeyRound className="h-5 w-5" />
            Help someone with their password
          </h2>
          <p className="text-sm text-muted-foreground">
            Set a new password for someone who cannot sign in. If they also belong to another household,
            they must use their own email recovery instead.
          </p>
          {resettable.map((member) => (
            <div key={member.id} className="rounded-lg border border-border bg-muted/60 p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{member.name}</p>
                  <p className="break-all text-sm text-muted-foreground">{member.email}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setResetFor(resetFor === member.id ? null : member.id)}
                >
                  {resetFor === member.id ? "Cancel" : "Set password"}
                </Button>
              </div>
              {resetFor === member.id ? (
                <form
                  className="mt-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void resetPassword(member.id, new FormData(event.currentTarget));
                  }}
                >
                  <Input name="password" type="password" placeholder="New password" aria-label={`New password for ${member.name}`} required minLength={8} />
                  <Input name="passwordConfirmation" type="password" placeholder="Confirm password" aria-label={`Confirm password for ${member.name}`} required minLength={8} />
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="requireFirstLoginPasswordChange" className="mt-1 h-4 w-4" defaultChecked />
                    <span>Require them to choose their own password at next sign-in</span>
                  </label>
                  <Button type="submit" disabled={busy}>{busy ? "Working…" : "Save new password"}</Button>
                </form>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
