"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invitationBrowserPartitionDigest, invitationDigest, invitationFingerprint, invitationOperationId } from "@/components/invitations/invitation-browser";

type Review = Record<string, unknown> & { household_name?: string; offered_role?: string; reviewVersion?: number; reviewSnapshotDigest?: string; remainingActiveCount?: number; status?: string };
type CodeEntry = { codeId: string; code: string };
type OperationKind = "credential" | "recovery-enrollment" | "recovery-rehearsal" | "accept";
type RetainedOperation = { kind: OperationKind; operationId: string; openingFingerprint: string; intentFingerprint?: string; recipientEmailDigest?: string; browserPartitionDigest?: string; selectedRecoveryCodeId?: string };
const retainedKey = "cubby:invitation-workflow-operation:v1";
const disclosureLabels: Array<[string, string]> = [
  ["household_name", "Household"], ["offered_role", "Offered access"], ["capabilities", "Capabilities"], ["restrictions", "Restrictions"],
  ["inviter_display_name", "Invited by"], ["masked_recipient", "Invited account"], ["server_utc_expiry", "Invitation expiry"], ["localized_relative_expiry", "Expiry timing"],
  ["reentry_state", "Session re-entry"], ["access_restrictions", "Access starts after acceptance"], ["attribution_audit_privacy", "Activity and audit privacy"], ["global_security_boundary", "Account security"],
  ["other_membership_boundary", "Other households"], ["recovery_signin_boundary", "Recovery and sign-in"]
];
const safeFailure = "We could not confirm that step. Refresh and try again.";

function readRetained(): RetainedOperation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(retainedKey) ?? "null") as RetainedOperation | null;
    return value && typeof value.operationId === "string" && typeof value.openingFingerprint === "string" && ["credential", "recovery-enrollment", "recovery-rehearsal", "accept"].includes(value.kind) ? value : null;
  } catch { return null; }
}
function writeRetained(value: RetainedOperation | null) { try { if (value) sessionStorage.setItem(retainedKey, JSON.stringify(value)); else sessionStorage.removeItem(retainedKey); } catch { /* Status remains authoritative. */ } }

function receipt(value: unknown) {
  const body = value as { ok?: boolean; data?: Record<string, unknown> } | null;
  return body?.ok && body.data ? body.data : null;
}

type P13RecoverySchemaObservation = { statusClass: "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "invalid"; ok: "true" | "false" | "absent"; data: "present" | "absent"; terminal: "generated" | "completed" | "unavailable" | "other" | "absent"; count: "exactly_10" | "other" | "absent"; shape: "valid" | "invalid" };
type P13RecoveryRouteOrigin = "setup_session_absent" | "setup_corridor_rejected" | "submit_service_error" | "submit_empty_receipt" | "submit_terminal_unavailable" | "submit_terminal_generated" | "submit_terminal_completed" | "submit_state_fresh_auth_bound" | "submit_state_prepared" | "submit_state_other" | "submit_receipt_invalid" | "submit_server_legacy_invalid" | "submit_header_unsupported" | "observer_absent";
const p13RecoverySchemaObserverEnabled = process.env.NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER === "1";
const p13RecoveryRouteOriginHeader = "X-Cubby-P13-Recovery-Origin";

export function p13RecoverySubmitSchemaObservation(status: number, value: unknown): P13RecoverySchemaObservation {
  const body = value && typeof value === "object" ? value as { ok?: unknown; data?: unknown } : undefined;
  const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : undefined;
  const entries = data?.codeEntries;
  const terminalValue = data?.status;
  const terminal = terminalValue === "generated" || terminalValue === "completed" || terminalValue === "unavailable" ? terminalValue : terminalValue === undefined ? "absent" : "other";
  const count = Array.isArray(entries) ? entries.length === 10 ? "exactly_10" : "other" : "absent";
  const shape = Array.isArray(entries) && entries.every((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).codeId === "string" && typeof (entry as Record<string, unknown>).code === "string") ? "valid" : "invalid";
  const statusClass = status >= 100 && status < 200 ? "1xx" : status >= 200 && status < 300 ? "2xx" : status >= 300 && status < 400 ? "3xx" : status >= 400 && status < 500 ? "4xx" : status >= 500 && status < 600 ? "5xx" : "invalid";
  return { statusClass, ok: body?.ok === true ? "true" : body?.ok === false ? "false" : "absent", data: data ? "present" : "absent", terminal, count, shape };
}

export function p13RecoverySubmitRouteOrigin(value: string | null): P13RecoveryRouteOrigin {
  if (value === null) return "observer_absent";
  if (value === "invalid") return "submit_server_legacy_invalid";
  return value === "setup_session_absent" || value === "setup_corridor_rejected" || value === "submit_service_error" || value === "submit_empty_receipt" || value === "submit_terminal_unavailable" || value === "submit_terminal_generated" || value === "submit_terminal_completed" || value === "submit_state_fresh_auth_bound" || value === "submit_state_prepared" || value === "submit_state_other" || value === "submit_receipt_invalid" ? value : "submit_header_unsupported";
}

function emitP13RecoverySubmitRouteOrigin(value: string | null) {
  if (!p13RecoverySchemaObserverEnabled) return;
  const observer = (globalThis as unknown as { __cubbyP13RecoveryOriginObserver?: (payload: string) => void }).__cubbyP13RecoveryOriginObserver;
  if (typeof observer !== "function") return;
  try { observer(p13RecoverySubmitRouteOrigin(value)); } catch { /* The test-only observer never affects application behavior. */ }
}

function emitP13RecoverySubmitSchemaObservation(status: number, value: unknown) {
  if (!p13RecoverySchemaObserverEnabled) return;
  const observer = (globalThis as unknown as { __cubbyP13RecoverySchemaObserver?: (payload: string) => void }).__cubbyP13RecoverySchemaObserver;
  if (typeof observer !== "function") return;
  try { observer(JSON.stringify(p13RecoverySubmitSchemaObservation(status, value))); } catch { /* The test-only observer never affects application behavior. */ }
}

export function InvitationWorkflow() {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [codes, setCodes] = useState<CodeEntry[]>([]);
  const [rehearsal, setRehearsal] = useState<CodeEntry | null>(null);
  const [freshPassword, setFreshPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState<RetainedOperation | null>(null);
  const errorSummary = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const claimEpoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());

  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }, []);
  useEffect(() => { if (!loading) heading.current?.focus(); }, [loading]);
  useEffect(() => { setRetained(readRetained()); }, []);
  useEffect(() => { if (message && message !== "Credentials are ready. Sign in to continue the invitation." && !message.startsWith("Recovery readiness")) errorSummary.current?.focus(); }, [message]);

  function retain(next: RetainedOperation | null) { writeRetained(next); setRetained(next); }

  const request = useCallback(async (path: string, method: "GET" | "POST", payload?: Record<string, unknown>) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const requestGeneration = ++generation.current;
    try {
      const response = await fetch(path, {
        method,
        cache: "no-store",
        signal: controller.signal,
        ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {})
      });
      const body = await response.json().catch(() => null);
      if (path === "/api/invitations/recovery/enrollment/submit" && method === "POST") {
        emitP13RecoverySubmitRouteOrigin(typeof response.headers?.get === "function" ? response.headers.get(p13RecoveryRouteOriginHeader) : null);
        emitP13RecoverySubmitSchemaObservation(response.status, body);
      }
      const data = receipt(body);
      return !controller.signal.aborted && generation.current === requestGeneration ? data : null;
    } finally {
      controllers.current.delete(controller);
    }
  }, []);

  const loadReview = useCallback(async () => {
    const reviewEpoch = claimEpoch.current;
    setLoading(true); setMessage("");
    try {
      const data = await request("/api/invitations/review", "GET");
      if (reviewEpoch !== claimEpoch.current) return;
      if (data && typeof data.household_name === "string" && typeof data.reviewSnapshotDigest === "string") setReview(data);
      else setReview(null);
    } catch { if (reviewEpoch === claimEpoch.current) setReview(null); }
    finally { if (reviewEpoch === claimEpoch.current) setLoading(false); }
  }, [request]);
  useEffect(() => { void loadReview(); }, [loadReview]);
  useEffect(() => {
    const onClaim = (event: Event) => {
      const claimed = (event as CustomEvent<{ claimed?: boolean }>).detail?.claimed;
      if (!claimed) return;
      claimEpoch.current += 1;
      void loadReview();
    };
    window.addEventListener("cubby:invitation-claim-complete", onClaim);
    return () => window.removeEventListener("cubby:invitation-claim-complete", onClaim);
  }, [loadReview]);

  async function setupCredentials(form: HTMLFormElement) {
    const data = new FormData(form);
    const displayName = String(data.get("displayName") ?? "").trim();
    const email = String(data.get("email") ?? "").trim().toLowerCase();
    const password = String(data.get("password") ?? "");
    if (!displayName || !email || password.length < 8) { setMessage(safeFailure); return; }
    setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "credential" ? retained.operationId : invitationOperationId();
      const browserPartitionDigest = await invitationBrowserPartitionDigest();
      const recipientEmailDigest = await invitationDigest(email);
      const openingFingerprint = await invitationFingerprint("credential", { operationId, email });
      const intentFingerprint = await invitationFingerprint("credential-submit", { operationId, displayName, email });
      if (retained?.kind === "credential" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint || retained.recipientEmailDigest !== recipientEmailDigest || retained.browserPartitionDigest !== browserPartitionDigest)) { setMessage("This differs from the retained credential request. Check its status before starting a new request."); return; }
      const base = { operationId, browserPartitionDigest, recipientEmailDigest, openingFingerprint };
      retain({ kind: "credential", operationId, openingFingerprint, intentFingerprint, browserPartitionDigest, recipientEmailDigest });
      const reserved = await request("/api/invitations/credentials/reserve", "POST", base);
      if (reserved?.status !== "prepared") throw new Error("reserve");
      const submitted = await request("/api/invitations/credentials/submit", "POST", { ...base, intentFingerprint, displayName, password });
      if (submitted?.status !== "continue_with_sign_in") throw new Error("submit");
      retain(null); form.reset(); setMessage("Credentials are ready. Sign in to continue the invitation.");
    } catch { setMessage(safeFailure); } finally { setBusy(false); }
  }

  async function generateCodes(event: MouseEvent<HTMLButtonElement>) {
    if (!freshPassword) { setMessage("Re-enter your new password before generating recovery codes."); return; }
    returnFocus.current = event.currentTarget; setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "recovery-enrollment" ? retained.operationId : invitationOperationId();
      const openingFingerprint = await invitationFingerprint("recovery-enrollment", { operationId });
      const intentFingerprint = await invitationFingerprint("recovery-enrollment-submit", { operationId });
      if (retained?.kind === "recovery-enrollment" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint)) { setMessage("This differs from the retained recovery request. Check its status before starting a new request."); return; }
      const operation: RetainedOperation = { kind: "recovery-enrollment", operationId, openingFingerprint, intentFingerprint };
      retain(operation);
      const reserved = await request("/api/invitations/recovery/enrollment/reserve", "POST", { operationId, openingFingerprint });
      if (reserved?.status !== "prepared" || typeof reserved.globalSecurityOperationId !== "string") throw new Error("reserve");
      const freshAuth = await request("/api/invitations/recovery/enrollment/fresh-auth", "POST", { operationId, openingFingerprint, intentFingerprint, globalSecurityOperationId: reserved.globalSecurityOperationId, currentPassword: freshPassword });
      if (freshAuth?.status !== "fresh_auth_bound") throw new Error("fresh-auth");
      const submitted = await request("/api/invitations/recovery/enrollment/submit", "POST", { operationId, openingFingerprint, intentFingerprint });
      const entries = Array.isArray(submitted?.codeEntries) ? submitted.codeEntries : [];
      if ((submitted?.status !== "generated" && submitted?.status !== "completed") || entries.length !== 10 || !entries.every((entry) => entry && typeof (entry as CodeEntry).codeId === "string" && typeof (entry as CodeEntry).code === "string")) throw new Error("codes");
      retain(null); setFreshPassword(""); setCodes(entries as CodeEntry[]);
    } catch { setMessage(safeFailure); } finally { setBusy(false); }
  }

  async function rehearse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rehearsal) return;
    const recoveryCode = String(new FormData(event.currentTarget).get("recoveryCode") ?? "");
    const acknowledgement = String(new FormData(event.currentTarget).get("acknowledgement") ?? "");
    if (acknowledgement !== "I SAVED MY RECOVERY CODES") { setMessage("Type the acknowledgement exactly before rehearsing one code."); return; }
    setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "recovery-rehearsal" ? retained.operationId : invitationOperationId();
      const openingFingerprint = await invitationFingerprint("recovery-rehearsal", { operationId, selectedRecoveryCodeId: rehearsal.codeId });
      const intentFingerprint = await invitationFingerprint("recovery-rehearsal-submit", { operationId, selectedRecoveryCodeId: rehearsal.codeId });
      if (retained?.kind === "recovery-rehearsal" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint || retained.selectedRecoveryCodeId !== rehearsal.codeId)) { setMessage("This differs from the retained rehearsal request. Check its status before starting a new request."); return; }
      retain({ kind: "recovery-rehearsal", operationId, openingFingerprint, intentFingerprint, selectedRecoveryCodeId: rehearsal.codeId });
      const reserved = await request("/api/invitations/recovery/rehearsal/reserve", "POST", { operationId, selectedRecoveryCodeId: rehearsal.codeId, acknowledgement, recoveryCode, openingFingerprint });
      if (reserved?.status !== "prepared" || typeof reserved.nonce !== "string" || !reserved.attestation || typeof (reserved.attestation as Record<string, unknown>).keyVersion !== "number" || typeof (reserved.attestation as Record<string, unknown>).mac !== "string") throw new Error("reserve");
      const attestation = reserved.attestation as { keyVersion: number; mac: string };
      const submitted = await request("/api/invitations/recovery/rehearsal/submit", "POST", { operationId, selectedRecoveryCodeId: rehearsal.codeId, openingFingerprint, intentFingerprint, nonce: reserved.nonce, attestationKeyVersion: attestation.keyVersion, attestationMac: attestation.mac });
      if (submitted?.status !== "rehearsed" && submitted?.status !== "completed") throw new Error("submit");
      retain(null); setCodes([]); setRehearsal(null); setReview((current) => current ? { ...current, remainingActiveCount: 9 } : current); setMessage("Recovery readiness confirmed: nine unused codes remain.");
    } catch { setMessage(safeFailure); } finally { setBusy(false); returnFocus.current?.focus(); }
  }

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!review?.household_name || !review.reviewVersion || !review.reviewSnapshotDigest) return;
    const form = new FormData(event.currentTarget); const typedHouseholdName = String(form.get("householdName") ?? "");
    const adminAcknowledgement = review.offered_role === "admin" ? String(form.get("adminAcknowledgement") ?? "") : null;
    setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "accept" ? retained.operationId : invitationOperationId();
      const openingFingerprint = await invitationFingerprint("accept", { operationId, reviewVersion: review.reviewVersion, reviewSnapshotDigest: review.reviewSnapshotDigest });
      const intentFingerprint = await invitationFingerprint("accept-submit", { operationId, typedHouseholdName, adminAcknowledgement });
      if (retained?.kind === "accept" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint)) { setMessage("This differs from the retained acceptance request. Check its status before starting a new request."); return; }
      const base = { operationId, reviewVersion: review.reviewVersion, reviewSnapshotDigest: review.reviewSnapshotDigest, openingFingerprint };
      retain({ kind: "accept", operationId, openingFingerprint, intentFingerprint });
      const reserved = await request("/api/invitations/accept/reserve", "POST", base);
      if (reserved?.status !== "prepared") throw new Error("reserve");
      const submitted = await request("/api/invitations/accept/submit", "POST", { ...base, intentFingerprint, typedHouseholdName, adminAcknowledgement });
      if (submitted?.status !== "accepted" && submitted?.status !== "completed") throw new Error("submit");
      retain(null); window.location.assign("/app");
    } catch { setMessage(safeFailure); } finally { setBusy(false); }
  }

  async function checkRetainedStatus() {
    if (!retained || busy) return;
    setBusy(true); setMessage("");
    try {
      let result: Record<string, unknown> | null = null;
      if (retained.kind === "credential") result = await request("/api/invitations/credentials/status", "POST", retained);
      if (retained.kind === "recovery-enrollment") result = await request("/api/invitations/recovery/enrollment/status", "POST", retained);
      if (retained.kind === "recovery-rehearsal") result = await request("/api/invitations/recovery/rehearsal/status", "POST", { ...retained, selectedRecoveryCodeId: retained.selectedRecoveryCodeId });
      if (retained.kind === "accept") result = await request("/api/invitations/accept/status", "POST", retained);
      if (!result) throw new Error("status");
      const status = String(result.status ?? "unavailable");
      if (status === "continue_with_sign_in" || status === "accepted" || status === "completed" || status === "rehearsed") { retain(null); setMessage(status === "continue_with_sign_in" ? "Credentials are ready. Sign in to continue the invitation." : "The retained invitation step completed."); }
      else if (status === "generated") { retain(null); setMessage("Recovery codes were generated, but display-once codes cannot be shown again. Start recovery enrollment again if required."); }
      else setMessage(`Invitation step status: ${status}.`);
    } catch { setMessage(safeFailure); } finally { setBusy(false); }
  }

  const retainedOperation = retained ? <section aria-label="Retained invitation operation" className="rounded-lg border border-border p-3"><p className="text-sm text-muted-foreground">A prior invitation step is retained for this browser. Re-enter the same information and retry it, or check its status before starting a different step.</p><Button type="button" variant="secondary" className="mt-2" onClick={() => void checkRetainedStatus()} disabled={busy}>Check retained step status</Button></section> : null;

  if (loading) return <p className="text-sm text-muted-foreground" aria-live="polite">Checking invitation status…</p>;
  if (!review) return (
    <section aria-labelledby="invite-access-heading" className="space-y-4">
      <h1 ref={heading} tabIndex={-1} id="invite-access-heading" className="font-editorial text-3xl font-bold">Continue your invitation</h1>
      <p className="text-sm text-muted-foreground">Sign in with the invited account, or create its first sign-in details. Both paths return here for the same review and acceptance steps.</p>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void setupCredentials(event.currentTarget); }} aria-label="Create invited account credentials">
        <label className="block text-sm font-semibold">Display name<Input name="displayName" autoComplete="name" required /></label>
        <label className="block text-sm font-semibold">Email<Input name="email" type="email" autoComplete="username" required /></label>
        <label className="block text-sm font-semibold">New password<Input name="password" type="password" autoComplete="new-password" minLength={8} required /></label>
        <Button type="submit" disabled={busy}>{busy ? "Working…" : "Create sign-in details"}</Button>
      </form>
      <Link className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline" href="/login">Sign in to continue</Link>
      {retainedOperation}
      {message ? <p ref={errorSummary} role="alert" tabIndex={-1} className="text-sm text-muted-foreground">{message}</p> : null}
    </section>
  );

  return <section aria-labelledby="invite-review-heading" className="space-y-5">
    <div><h1 ref={heading} tabIndex={-1} id="invite-review-heading" className="font-editorial text-3xl font-bold">Review your invitation</h1><p className="mt-1 text-sm text-muted-foreground">Read the fourteen invitation disclosures before joining.</p></div>
    <dl aria-label="Invitation disclosures" className="grid gap-3 text-sm sm:grid-cols-2">{disclosureLabels.map(([key, label]) => <div key={key} className="min-w-0 rounded-lg border border-border bg-muted/50 p-3"><dt className="font-semibold">{label}</dt><dd className="mt-1 break-words text-muted-foreground">{String(review[key] ?? "Not available")}</dd></div>)}</dl>
    {review.remainingActiveCount === 9 ? <p className="rounded-lg bg-muted p-3 text-sm font-semibold" role="status" aria-live="polite">Recovery readiness complete: exactly nine unused codes remain.</p> : null}
    {review.remainingActiveCount !== 9 && codes.length === 0 ? <div className="space-y-2 rounded-lg border border-border p-3"><label className="block text-sm font-semibold">Re-enter your new password<Input value={freshPassword} onChange={(event) => setFreshPassword(event.target.value)} type="password" autoComplete="current-password" required /></label><p className="text-sm text-muted-foreground">This fresh authentication is required before recovery codes can be generated.</p><Button type="button" onClick={(event) => void generateCodes(event)} disabled={busy}>Generate recovery codes</Button></div> : null}
    {codes.length > 0 ? <section role="region" aria-label="Display-once recovery codes" aria-live="off" tabIndex={-1} ref={(node) => { if (node) node.focus(); }} className="space-y-3 rounded-lg border border-border p-3"><h2 id="recovery-codes-heading" className="text-lg font-bold">Save these ten recovery codes now</h2><p className="text-sm text-muted-foreground">They are displayed only in this response. Save them before selecting one for the required rehearsal.</p><ol className="grid gap-2 text-sm sm:grid-cols-2">{codes.map((entry) => <li key={entry.codeId}><Button type="button" variant="secondary" className="w-full justify-start break-all font-mono" onClick={(event) => { returnFocus.current = event.currentTarget; setRehearsal(entry); }}>{entry.code}</Button></li>)}</ol></section> : null}
    {rehearsal ? <form onSubmit={(event) => void rehearse(event)} className="space-y-3 rounded-lg border border-border p-3" aria-labelledby="rehearsal-heading"><h2 id="rehearsal-heading" className="text-lg font-bold">Rehearse one saved code</h2><label className="block text-sm font-semibold">Type the selected code<Input name="recoveryCode" autoComplete="one-time-code" required /></label><label className="block text-sm font-semibold">Type <span className="font-mono">I SAVED MY RECOVERY CODES</span><Input name="acknowledgement" autoComplete="off" required /></label><Button type="submit" disabled={busy}>Confirm recovery readiness</Button></form> : null}
    {review.remainingActiveCount === 9 ? <form onSubmit={(event) => void accept(event)} className="space-y-3 border-t border-border pt-5" aria-labelledby="accept-heading"><h2 id="accept-heading" className="text-lg font-bold">Join {review.household_name}</h2><label className="block text-sm font-semibold">Type the household name exactly<Input name="householdName" autoComplete="off" required /></label>{review.offered_role === "admin" ? <label className="block text-sm font-semibold">Type <span className="font-mono">I UNDERSTAND ADMIN ACCESS</span><Input name="adminAcknowledgement" autoComplete="off" required /></label> : null}<div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>Accept invitation</Button><Link href="/" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-muted-foreground underline-offset-4 hover:underline">Decline and leave</Link></div></form> : null}
    {retainedOperation}
    {message ? <p ref={errorSummary} role="alert" tabIndex={-1} className="text-sm text-muted-foreground">{message}</p> : null}
  </section>;
}
