"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createGlobalSecurityOperationMetadata } from "@/lib/global-security-operation-metadata";

/**
 * Password-only corridor. It deliberately does not reuse the full account security panel, which
 * also exposes recovery enrollment and email changes that a restricted identity must not reach.
 */
export function RequiredPasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setMessage("");
    if (newPassword !== confirmation) {
      setMessage("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const metadata = createGlobalSecurityOperationMetadata();
      const response = await fetch("/api/account/security/required-password-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: metadata.operationId,
          openingFingerprint: metadata.openingFingerprint,
          intentFingerprint: metadata.intentFingerprint,
          currentPassword,
          newPassword,
          newPasswordConfirmation: confirmation
        })
      });
      const body = await response.json().catch(() => null) as
        { ok?: boolean; error?: { code?: string; message?: string } } | null;
      if (!response.ok || body?.ok !== true) {
        setMessage(body?.error?.message ?? "That password could not be set. Try again.");
        return;
      }
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
    } catch {
      setMessage("That password could not be set. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your password is set. Sign in again with your new password to continue.
        </p>
        <a href="/login">
          <Button>Go to sign in</Button>
        </a>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-1">
        <label className="text-sm font-semibold" htmlFor="required-current-password">Current password</label>
        <Input
          id="required-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-semibold" htmlFor="required-new-password">New password</label>
        <Input
          id="required-new-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-semibold" htmlFor="required-confirm-password">Confirm new password</label>
        <Input
          id="required-confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
      </div>
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      <Button type="submit" disabled={busy}>{busy ? "Setting password…" : "Set my password"}</Button>
    </form>
  );
}
