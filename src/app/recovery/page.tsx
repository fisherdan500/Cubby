"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createGlobalSecurityOperationMetadata, type GlobalSecurityOperationMetadata } from "@/lib/global-security-operation-metadata";

const recoveryResetKey = "cubby:global-security:recovery-reset-operation";

function retainedOperation(): GlobalSecurityOperationMetadata | null {
  try {
    const raw = sessionStorage.getItem(recoveryResetKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join("|") !== "intentFingerprint|openingFingerprint|operationId") return null;
    if (typeof value.operationId !== "string" || !/^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(value.operationId)) return null;
    if (typeof value.openingFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.openingFingerprint)) return null;
    if (typeof value.intentFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.intentFingerprint)) return null;
    return value as GlobalSecurityOperationMetadata;
  } catch {
    return null;
  }
}

export default function RecoveryPage() {
  const [form, setForm] = useState({ email: "", code: "", newPassword: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const operation = retainedOperation() ?? createGlobalSecurityOperationMetadata();
      sessionStorage.setItem(recoveryResetKey, JSON.stringify(operation));
      const submitted = form;
      setForm({ email: "", code: "", newPassword: "" });
      const response = await fetch("/api/account/recovery/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...submitted, ...operation }) });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null;
      if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? "Recovery could not be submitted.");
      sessionStorage.removeItem(recoveryResetKey);
      setMessage("If the recovery information is accepted, your password has been reset. Sign in normally to continue.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery could not be submitted."); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto min-h-screen max-w-md space-y-5 px-3 py-12 md:px-8" aria-busy={busy ? "true" : "false"}><Link href="/login" className="text-sm font-bold text-primary">Back to sign in</Link><div><h1 className="font-editorial text-3xl font-bold">Recover your account</h1><p className="mt-2 text-sm text-muted-foreground">Use a saved offline recovery code. This process never signs you in automatically.</p></div><form aria-label="Recover your account" className="space-y-3 rounded-lg border border-border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label htmlFor="recovery-email" className="text-sm font-semibold">Email address</label><input id="recovery-email" aria-label="Email address" type="email" autoComplete="email" disabled={busy} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><label htmlFor="recovery-code" className="text-sm font-semibold">Recovery code</label><input id="recovery-code" aria-label="Recovery code" type="text" autoComplete="off" disabled={busy} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><label htmlFor="recovery-new-password" className="text-sm font-semibold">New password</label><input id="recovery-new-password" aria-label="New password" type="password" autoComplete="new-password" disabled={busy} value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><Button type="submit" disabled={busy || !form.email || !form.code || form.newPassword.length < 8} className="w-full">Reset password</Button></form><p aria-live="polite" role="status" className="text-sm text-muted-foreground">{message}</p></main>;
}
