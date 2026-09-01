"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createGlobalSecurityOperationMetadata, type GlobalSecurityOperationMetadata } from "@/lib/global-security-operation-metadata";

type RecoverySaved = GlobalSecurityOperationMetadata & { setVersion?: number; action: "enroll" | "regenerate" };
type EmailSaved = GlobalSecurityOperationMetadata;
type RetryState = "idle" | "reconciling" | "retry" | "pending";

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const read = <T,>(key: string): T | null => {
  try { const value = sessionStorage.getItem(key); return value ? JSON.parse(value) as T : null; }
  catch { return null; }
};
const write = (key: string, value: unknown) => sessionStorage.setItem(key, JSON.stringify(value));
const recoveryStatusPayload = (value: RecoverySaved) => ({ action: "status", operationId: value.operationId, openingFingerprint: value.openingFingerprint, intentFingerprint: value.intentFingerprint });
const terminalPasswordStatus = (status: unknown) => ["completed", "rejected", "stale"].includes(String(status));
const terminalRecoveryState = (state: unknown) => ["rehearsed", "invalidated"].includes(String(state));
const terminalEmailState = (status: unknown, cookieState: unknown) => ["cancelled", "confirmed", "failed", "expired", "rejected", "signed_out"].includes(String(status)) || cookieState === "confirmed";

async function post(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } | null;
  if (!response.ok || body?.ok !== true || !body.data) throw new RequestError(body?.error?.message ?? "Account security request failed.", response.status, body?.error?.code);
  return body.data;
}

export function AccountSecurityPanel({ accountScope, onSignInRequired }: { accountScope: string; onSignInRequired?: () => void }) {
  const router = useRouter();
  const activeAccountScopeRef = useRef(accountScope);
  const isActiveAccountScope = useCallback((scope: string) => activeAccountScopeRef.current === scope, []);
  const keys = useMemo(() => {
    const prefix = `cubby:global-security:${encodeURIComponent(accountScope)}`;
    return { password: `${prefix}:password-operation`, recovery: `${prefix}:recovery-operation`, email: `${prefix}:email-operation` };
  }, [accountScope]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [stateAccountScope, setStateAccountScope] = useState(accountScope);
  const [password, setPassword] = useState({ current: "", next: "" });
  const [passwordOperation, setPasswordOperation] = useState<GlobalSecurityOperationMetadata | null>(null);
  const [passwordState, setPasswordState] = useState<RetryState>("idle");
  const [recovery, setRecovery] = useState<RecoverySaved | null>(null);
  const [recoveryState, setRecoveryState] = useState<RetryState>("idle");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [rehearsalCode, setRehearsalCode] = useState("");
  const [email, setEmail] = useState({ current: "", next: "", verification: "" });
  const [emailOperation, setEmailOperation] = useState<EmailSaved | null>(null);
  const [emailState, setEmailState] = useState<RetryState>("idle");
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailCookieState, setEmailCookieState] = useState<string | null>(null);
  const [emailOldAddressNoticeFailed, setEmailOldAddressNoticeFailed] = useState(false);

  const clearPasswordOperation = useCallback(() => { sessionStorage.removeItem(keys.password); setPasswordOperation(null); setPasswordState("idle"); }, [keys.password]);
  const clearRecoveryOperation = useCallback(() => { sessionStorage.removeItem(keys.recovery); setRecovery(null); setRecoveryState("idle"); }, [keys.recovery]);
  const clearEmailOperation = useCallback(() => { sessionStorage.removeItem(keys.email); setEmailOperation(null); setEmailState("idle"); setEmailStatus(null); setEmailCookieState(null); }, [keys.email]);

  useEffect(() => {
    const effectScope = accountScope;
    activeAccountScopeRef.current = effectScope;
    setStateAccountScope(effectScope);
    setMessage(""); setBusy(null); setRecoveryCodes([]); setRehearsalCode(""); setRecoveryPassword(""); setPassword({ current: "", next: "" }); setEmail({ current: "", next: "", verification: "" }); setEmailOldAddressNoticeFailed(false);
    const savedPassword = read<GlobalSecurityOperationMetadata>(keys.password);
    const savedRecovery = read<RecoverySaved>(keys.recovery);
    const savedEmail = read<EmailSaved>(keys.email);
    setPasswordOperation(savedPassword); setPasswordState(savedPassword ? "reconciling" : "idle");
    setRecovery(savedRecovery); setRecoveryState(savedRecovery ? "reconciling" : "idle");
    setEmailOperation(savedEmail); setEmailState(savedEmail ? "reconciling" : "idle");
    void (async () => {
      if (savedPassword) {
        try {
          const result = await post("/api/account/security/password/status", savedPassword);
          if (!isActiveAccountScope(effectScope)) return;
          if (terminalPasswordStatus(result.status)) clearPasswordOperation();
          else setPasswordState("pending");
          setMessage(`Password-change status: ${String(result.status)}.`);
        } catch (error) { if (isActiveAccountScope(effectScope)) setPasswordState(error instanceof RequestError && error.status === 404 ? "retry" : "pending"); }
      }
      if (savedRecovery) {
        try {
          const result = await post("/api/account/security/recovery", recoveryStatusPayload(savedRecovery));
          if (!isActiveAccountScope(effectScope)) return;
          if (terminalRecoveryState(result.state)) clearRecoveryOperation();
          else if (result.state === "generated") {
            clearRecoveryOperation();
            setMessage("Those display-once codes cannot be shown again. Regenerate recovery codes to continue.");
          } else {
            const reconciled = { ...savedRecovery, setVersion: typeof result.setVersion === "number" ? result.setVersion : savedRecovery.setVersion };
            write(keys.recovery, reconciled); setRecovery(reconciled); setRecoveryState("pending");
            setMessage(`Recovery status: ${String(result.state)}.`);
          }
        } catch (error) { if (isActiveAccountScope(effectScope)) setRecoveryState(error instanceof RequestError && error.status === 404 ? "retry" : "pending"); }
      }
      if (savedEmail) {
        try {
          const result = await post("/api/account/security/email-change", { action: "status", operationId: savedEmail.operationId });
          if (!isActiveAccountScope(effectScope)) return;
          const status = String(result.status); const cookieState = result.cookieState == null ? null : String(result.cookieState);
          if (typeof result.oldAddressNoticeFailed === "boolean") setEmailOldAddressNoticeFailed(result.oldAddressNoticeFailed);
          setEmailStatus(status); setEmailCookieState(cookieState);
          if (terminalEmailState(status, cookieState)) clearEmailOperation(); else setEmailState("pending");
          setMessage(`Email-change status: ${status}.`);
        } catch (error) { if (isActiveAccountScope(effectScope)) setEmailState(error instanceof RequestError && error.status === 404 ? "retry" : "pending"); }
      }
    })();
    const clearDisplayOnly = () => setRecoveryCodes([]);
    window.addEventListener("pagehide", clearDisplayOnly);
    return () => {
      window.removeEventListener("pagehide", clearDisplayOnly);
      if (activeAccountScopeRef.current === effectScope) activeAccountScopeRef.current = "";
    };
  }, [accountScope, clearEmailOperation, clearPasswordOperation, clearRecoveryOperation, isActiveAccountScope, keys.email, keys.password, keys.recovery]);

  async function changePassword() {
    if (busy) return;
    const requestScope = accountScope;
    setBusy("password"); setMessage("");
    const currentPassword = password.current; const newPassword = password.next;
    try {
      const operation = passwordOperation ?? createGlobalSecurityOperationMetadata();
      write(keys.password, operation); setPasswordOperation(operation); setPasswordState("pending"); setPassword({ current: "", next: "" });
      const result = await post("/api/account/security/password", { ...operation, currentPassword, newPassword });
      if (!isActiveAccountScope(requestScope)) return;
      if (result.signInRequired) { clearPasswordOperation(); setMessage("Password changed. Sign in again with your new password."); if (onSignInRequired) onSignInRequired(); else { router.replace("/login"); router.refresh(); } }
      else setMessage("Password change completed.");
    } catch (error) { if (isActiveAccountScope(requestScope)) { setPasswordState("retry"); setMessage(error instanceof Error ? error.message : "Password change could not be completed. Check status before retrying."); } }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function reconcilePassword() {
    if (!passwordOperation || busy) return; const requestScope = accountScope; setBusy("password-status");
    try { const result = await post("/api/account/security/password/status", passwordOperation); if (!isActiveAccountScope(requestScope)) return; if (terminalPasswordStatus(result.status)) clearPasswordOperation(); else setPasswordState("pending"); setMessage(`Password-change status: ${String(result.status)}.`); }
    catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Password status could not be checked."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function issueRecovery(action: "enroll" | "regenerate") {
    if (busy) return; const requestScope = accountScope; setBusy("recovery"); setMessage("");
    const currentPassword = recoveryPassword;
    try {
      const operation = recovery ?? { ...createGlobalSecurityOperationMetadata(), action };
      if (recovery && recovery.action !== action) throw new Error("Retry the original recovery operation or check its status before starting another one.");
      write(keys.recovery, operation); setRecovery(operation); setRecoveryState("pending"); setRecoveryPassword(""); setPassword({ current: "", next: "" });
      const result = await post("/api/account/security/recovery", { operationId: operation.operationId, openingFingerprint: operation.openingFingerprint, intentFingerprint: operation.intentFingerprint, action, currentPassword });
      if (!isActiveAccountScope(requestScope)) return;
      const codes = Array.isArray(result.codes) ? result.codes.filter((value): value is string => typeof value === "string") : [];
      if (!Number.isInteger(result.setVersion) || !codes.length) throw new Error("Recovery codes could not be displayed.");
      const saved: RecoverySaved = { ...operation, setVersion: result.setVersion as number };
      write(keys.recovery, saved); setRecovery(saved); setRecoveryState("pending"); setRecoveryCodes(codes);
      setMessage("Save these recovery codes now. They will not be shown again.");
    } catch (error) { if (isActiveAccountScope(requestScope)) { setRecoveryState("retry"); setMessage(error instanceof Error ? error.message : "Recovery enrollment could not be completed. Check status before retrying."); } }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function acknowledgeCodes() {
    if (!recovery?.setVersion || busy) return;
    const requestScope = accountScope;
    setRecoveryCodes([]); setBusy("recovery-acknowledge");
    try { await post("/api/account/security/recovery", { action: "acknowledge", operationId: recovery.operationId, setVersion: recovery.setVersion }); if (!isActiveAccountScope(requestScope)) return; setMessage("Saved acknowledgement recorded. Rehearse one unused code to finish enrollment."); }
    catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Acknowledgement status is uncertain. Check recovery status before continuing."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function rehearse() {
    if (!recovery?.setVersion || busy) return; const requestScope = accountScope; const code = rehearsalCode; setRehearsalCode(""); setBusy("recovery-rehearse");
    try { const result = await post("/api/account/security/recovery", { ...recovery, action: "rehearse", setVersion: recovery.setVersion, code }); if (!isActiveAccountScope(requestScope)) return; if (result.state === "rehearsed") clearRecoveryOperation(); setMessage(result.state === "rehearsed" ? "Recovery enrollment is ready." : "Recovery rehearsal status updated."); }
    catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Recovery rehearsal could not be completed."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function reconcileRecovery() {
    if (!recovery || busy) return; const requestScope = accountScope; setBusy("recovery-status");
    try { const result = await post("/api/account/security/recovery", recoveryStatusPayload(recovery)); if (!isActiveAccountScope(requestScope)) return; if (terminalRecoveryState(result.state)) clearRecoveryOperation(); else setRecoveryState("pending"); setMessage(`Recovery status: ${String(result.state)}.`); }
    catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Recovery status could not be checked."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function initiateEmailChange() {
    if (busy) return; const requestScope = accountScope; setBusy("email-initiate"); setMessage("");
    const currentPassword = email.current; const newEmail = email.next;
    try {
      const operation = emailOperation ?? createGlobalSecurityOperationMetadata();
      write(keys.email, operation); setEmailOperation(operation); setEmailState("pending"); setEmailOldAddressNoticeFailed(false); setEmail((value) => ({ ...value, current: "", next: "" }));
      const result = await post("/api/account/security/email-change", { ...operation, action: "initiate", currentPassword, newEmail });
      if (!isActiveAccountScope(requestScope)) return;
      setEmailStatus(String(result.status)); setMessage(result.status === "pending" ? "Enter the verification material delivered to the new address." : "Email-change status updated.");
    } catch (error) { if (isActiveAccountScope(requestScope)) { setEmailState("retry"); setMessage(error instanceof Error ? error.message : "Email change could not be started. Check status before retrying."); } }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function emailAction(action: "status" | "cancel" | "confirm" | "cutover") {
    if (!emailOperation || busy) return; const requestScope = accountScope; setBusy(`email-${action}`);
    try {
      const result = await post("/api/account/security/email-change", { action, operationId: emailOperation.operationId });
      if (!isActiveAccountScope(requestScope)) return;
      const status = String(result.status); const cookieState = result.cookieState == null ? emailCookieState : String(result.cookieState);
      if (typeof result.oldAddressNoticeFailed === "boolean") setEmailOldAddressNoticeFailed(result.oldAddressNoticeFailed);
      setEmailStatus(status); setEmailCookieState(cookieState);
      if (action === "cancel" || terminalEmailState(status, cookieState)) clearEmailOperation();
      setMessage(`Email-change status: ${status}.`);
      if (status === "signed_out" || result.signInRequired === true) {
        if (onSignInRequired) onSignInRequired();
        else { router.replace("/login"); router.refresh(); }
      }
    } catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Email-change action could not be completed."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  async function verifyEmailChange() {
    if (!emailOperation || busy) return; const requestScope = accountScope; const verification = email.verification; setEmail((value) => ({ ...value, verification: "" })); setBusy("email-verify");
    try { const result = await post("/api/account/security/email-change", { action: "verify", operationId: emailOperation.operationId, verification }); if (!isActiveAccountScope(requestScope)) return; setEmailStatus(String(result.status)); setMessage(`Email-change status: ${String(result.status)}.`); }
    catch (error) { if (isActiveAccountScope(requestScope)) setMessage(error instanceof Error ? error.message : "Verification could not be completed."); }
    finally { if (isActiveAccountScope(requestScope)) setBusy(null); }
  }

  const passwordRetry = passwordState === "retry";
  const recoveryRetry = recoveryState === "retry";
  const emailRetry = emailState === "retry";
  const emailPending = Boolean(emailOperation) && emailState !== "reconciling";

  if (stateAccountScope !== accountScope) {
    return <section className="space-y-6" aria-label="Account security controls" aria-busy="true"><p className="text-sm text-muted-foreground">Loading account security...</p></section>;
  }

  return <section className="space-y-6" aria-label="Account security controls" aria-busy={busy ? "true" : "false"}>
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="change-password-heading"><h2 id="change-password-heading" className="font-editorial text-xl font-bold">Change password</h2><form aria-labelledby="change-password-heading" className="space-y-3" onSubmit={(event) => { event.preventDefault(); void changePassword(); }}><label htmlFor="password-current" className="text-sm font-semibold">Current password</label><input id="password-current" aria-label="Current password for password change" type="password" autoComplete="current-password" value={password.current} onChange={(event) => setPassword({ ...password, current: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><label htmlFor="password-next" className="text-sm font-semibold">New password</label><input id="password-next" aria-label="New password" type="password" autoComplete="new-password" value={password.next} onChange={(event) => setPassword({ ...password, next: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><div className="flex flex-wrap gap-2"><Button type="submit" disabled={Boolean(busy) || passwordState === "reconciling" || passwordState === "pending" || !password.current || password.next.length < 8}>{passwordRetry ? "Retry password change" : "Change password"}</Button><Button type="button" variant="secondary" onClick={() => void reconcilePassword()} disabled={Boolean(busy) || !passwordOperation}>Check password-change status</Button></div></form></section>
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="offline-recovery-heading"><h2 id="offline-recovery-heading" className="font-editorial text-xl font-bold">Offline recovery codes</h2><p className="text-sm text-muted-foreground">Enroll, save, and rehearse a recovery code. Recovery always ends with a normal sign-in.</p><label htmlFor="recovery-current" className="text-sm font-semibold">Current password</label><input id="recovery-current" aria-label="Current password for recovery codes" type="password" autoComplete="current-password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void issueRecovery("enroll")} disabled={Boolean(busy) || recoveryState === "reconciling" || recoveryState === "pending" || !recoveryPassword}>{recoveryRetry && recovery?.action === "enroll" ? "Retry recovery enrollment" : "Create recovery codes"}</Button><Button variant="secondary" onClick={() => void issueRecovery("regenerate")} disabled={Boolean(busy) || recoveryState === "reconciling" || recoveryState === "pending" || !recoveryPassword}>{recoveryRetry && recovery?.action === "regenerate" ? "Retry recovery regeneration" : "Regenerate recovery codes"}</Button><Button variant="secondary" onClick={() => void reconcileRecovery()} disabled={Boolean(busy) || !recovery}>Check recovery status</Button></div>{recoveryCodes.length ? <div role="region" aria-label="Display-once recovery codes"><p className="font-semibold">Save these codes outside Cubby now.</p><ul className="grid grid-cols-2 gap-2 text-sm">{recoveryCodes.map((code) => <li key={code} className="rounded border border-border p-2 font-mono">{code}</li>)}</ul><Button onClick={() => void acknowledgeCodes()} disabled={Boolean(busy)}>I saved these codes</Button></div> : null}{recovery?.setVersion && !recoveryCodes.length ? <div className="space-y-2"><label className="text-sm font-semibold" htmlFor="rehearsal-code">Rehearse one unused code</label><input id="rehearsal-code" type="text" autoComplete="off" value={rehearsalCode} onChange={(event) => setRehearsalCode(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><Button variant="secondary" onClick={() => void rehearse()} disabled={Boolean(busy) || !rehearsalCode}>Rehearse code</Button></div> : null}</section>
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="change-email-heading"><h2 id="change-email-heading" className="font-editorial text-xl font-bold">Change email address</h2><form aria-labelledby="change-email-heading" className="space-y-3" onSubmit={(event) => { event.preventDefault(); void initiateEmailChange(); }}><label htmlFor="email-current" className="text-sm font-semibold">Current password</label><input id="email-current" aria-label="Current password for email change" type="password" autoComplete="current-password" value={email.current} onChange={(event) => setEmail({ ...email, current: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><label htmlFor="email-next" className="text-sm font-semibold">New email address</label><input id="email-next" aria-label="New email address" type="email" autoComplete="email" value={email.next} onChange={(event) => setEmail({ ...email, next: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><Button type="submit" variant="secondary" disabled={Boolean(busy) || emailState === "reconciling" || emailState === "pending" || !email.current || !email.next}>{emailRetry ? "Retry email change" : "Send verification"}</Button></form>{emailPending ? <div className="space-y-2"><label htmlFor="email-verification" className="text-sm font-semibold">Verification material</label><input id="email-verification" type="text" autoComplete="off" value={email.verification} onChange={(event) => setEmail({ ...email, verification: event.target.value })} className="min-h-11 w-full rounded-lg border border-border bg-background px-3" /><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void verifyEmailChange()} disabled={Boolean(busy) || emailStatus !== "pending" || !email.verification}>Verify new address</Button><Button onClick={() => void emailAction("cutover")} disabled={Boolean(busy) || emailStatus !== "verified"}>Complete email change</Button><Button variant="secondary" onClick={() => void emailAction("status")} disabled={Boolean(busy)}>Check email-change status</Button><Button variant="secondary" onClick={() => void emailAction("cancel")} disabled={Boolean(busy) || !["pending", "verified"].includes(String(emailStatus))}>Cancel email change</Button><Button variant="secondary" onClick={() => void emailAction("confirm")} disabled={Boolean(busy) || !(emailStatus === "issued" || emailCookieState === "issued")}>Confirm this device</Button></div></div> : null}{emailOldAddressNoticeFailed ? <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">The security notice to your old email address could not be delivered. Review your security history and active sessions.</p> : null}</section>
    <p aria-live="polite" role="status" className="text-sm text-muted-foreground">{message}</p>
  </section>;
}