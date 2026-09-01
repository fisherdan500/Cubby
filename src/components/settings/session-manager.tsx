"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

const operationStorageKeyPrefix = "cubby:global-session-revoke-operation";
const absentTargetHandle = "absent_target_handle";
const crockford = "0123456789abcdefghjkmnpqrstvwxyz";

type SessionRow = {
  handle: string;
  isCurrent: boolean;
  deviceLabel: string;
  createdAt: string;
  lastQualifyingAt: string;
  idleWarningAt: string | null;
  expiresAt: string;
};

type RevokeScope = "current" | "one" | "others" | "all";
type RevokeAction = { scope: RevokeScope; targetHandle?: string; label: string };
type OperationMetadata = { operationId: string; openingFingerprint: string; intentFingerprint: string };
type LoadState = "loading" | "ready" | "error";
type StatusResult = "terminal" | "pending" | "unknown";

function frameUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  const framed = new Uint8Array(4 + bytes.length);
  new DataView(framed.buffer).setUint32(0, bytes.length, false);
  framed.set(bytes, 4);
  return framed;
}

async function sha256Framed(...values: string[]) {
  const frames = values.map(frameUtf8);
  const bytes = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mintOperationId() {
  const random = crypto.getRandomValues(new Uint8Array(17));
  let value = 0n;
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = crockford[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `gso_${encoded}`;
}

function readRetainedOperation(operationStorageKey: string): OperationMetadata | null {
  const value = sessionStorage.getItem(operationStorageKey);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join("|") === "intentFingerprint|openingFingerprint|operationId" &&
      typeof parsed.operationId === "string" && /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(parsed.operationId) &&
      typeof parsed.openingFingerprint === "string" && /^[0-9a-f]{64}$/.test(parsed.openingFingerprint) &&
      typeof parsed.intentFingerprint === "string" && /^[0-9a-f]{64}$/.test(parsed.intentFingerprint)
    ) return parsed as OperationMetadata;
  } catch {
    // Invalid local metadata is not an operation authority.
  }
  sessionStorage.removeItem(operationStorageKey);
  return null;
}

function dateLabel(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

async function responseData(response: Response) {
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: { message?: string } } | null;
  return { body, data: body?.data as Record<string, unknown> | undefined };
}

export function SessionManager({ accountScope }: { accountScope: string }) {
  const router = useRouter();
  const operationStorageKey = `${operationStorageKeyPrefix}:${encodeURIComponent(accountScope)}`;
  const accountScopeRef = useRef(accountScope);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<RevokeAction | null>(null);
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationOpenerRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function load() {
    const requestedAccountScope = accountScope;
    if (accountScopeRef.current !== requestedAccountScope) return;
    setLoadState("loading");
    setMessage("");
    try {
      const response = await fetch("/api/account/sessions", { cache: "no-store" });
      const { body, data } = await responseData(response);
      if (accountScopeRef.current !== requestedAccountScope) return;
      if (!response.ok || body?.ok !== true || !Array.isArray(data?.sessions)) throw new Error(body?.error?.message ?? "Sessions could not be loaded.");
      setSessions(data.sessions as SessionRow[]);
      setLoadState("ready");
    } catch (error) {
      if (accountScopeRef.current !== requestedAccountScope) return;
      setSessions([]);
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "Sessions could not be loaded.");
    }
  }

  useEffect(() => {
    accountScopeRef.current = accountScope;
    setSessions([]);
    setLoadState("loading");
    setMessage("");
    setBusy(false);
    setConfirmation(null);
    setPassword("");
    readRetainedOperation(operationStorageKey);
    void load();
  // `load` deliberately captures this exact account scope and rejects late responses after a scope change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountScope, operationStorageKey]);
  useEffect(() => { if (confirmation) passwordRef.current?.focus(); }, [confirmation]);

  function openConfirmation(action: RevokeAction, opener: HTMLButtonElement) {
    setMessage("");
    setPassword("");
    confirmationOpenerRef.current = opener;
    setConfirmation(action);
  }

  function closeConfirmation() {
    setPassword("");
    setConfirmation(null);
    window.setTimeout(() => {
      const opener = confirmationOpenerRef.current;
      if (opener?.isConnected && !opener.disabled) opener.focus();
      else headingRef.current?.focus();
    }, 0);
  }

  async function checkStatus(metadata: OperationMetadata): Promise<StatusResult> {
    if (accountScopeRef.current !== accountScope) return "unknown";
    try {
      const response = await fetch("/api/account/sessions/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(metadata)
      });
      const { body, data } = await responseData(response);
      if (accountScopeRef.current !== accountScope) return "unknown";
      if (!response.ok || body?.ok !== true) return "unknown";
      if (data?.status === "revoked" || data?.status === "already_revoked" || data?.status === "stale_security_version") {
        if (accountScopeRef.current === accountScope) sessionStorage.removeItem(operationStorageKey);
        return "terminal";
      }
      return data?.status === "pending" ? "pending" : "unknown";
    } catch {
      return "unknown";
    }
  }

  async function finishTerminalReconciliation(action: RevokeAction) {
    if (accountScopeRef.current !== accountScope) return;
    closeConfirmation();
    if (action.scope === "current" || action.scope === "all") {
      router.push("/login");
      router.refresh();
    } else {
      await load();
    }
  }

  async function operationFor(action: RevokeAction) {
    const target = action.targetHandle ?? absentTargetHandle;
    const intentFingerprint = await sha256Framed(action.scope, target);
    if (accountScopeRef.current !== accountScope) throw new Error("account_scope_changed");
    const retained = readRetainedOperation(operationStorageKey);
    if (retained) {
      const status = await checkStatus(retained);
      if (accountScopeRef.current !== accountScope) throw new Error("account_scope_changed");
      if (status === "unknown") throw new Error("The previous sign-out result is still unknown. Try checking again before reissuing it.");
      if (status === "pending" && retained.intentFingerprint !== intentFingerprint) {
        throw new Error("Another session sign-out is still pending. Resolve it before starting a different action.");
      }
      if (status === "pending") return retained;
      if (status === "terminal") return null;
    }
    const operationId = mintOperationId();
    const metadata = {
      operationId,
      openingFingerprint: await sha256Framed("session_revoke_opening", operationId, action.scope, target),
      intentFingerprint
    };
    if (accountScopeRef.current !== accountScope) throw new Error("account_scope_changed");
    sessionStorage.setItem(operationStorageKey, JSON.stringify(metadata));
    return metadata;
  }

  async function confirmRevoke() {
    if (!confirmation || !password) return;
    const action = confirmation;
    const currentPassword = password;
    setPassword("");
    setBusy(true);
    setMessage("");
    let metadata: OperationMetadata | null = null;
    let reconciliationAttempted = false;
    try {
      if (accountScopeRef.current !== accountScope) return;
      metadata = await operationFor(action);
      if (accountScopeRef.current !== accountScope) return;
      if (!metadata) {
        closeConfirmation();
        await load();
        return;
      }
      if (accountScopeRef.current !== accountScope) return;
      const response = await fetch("/api/account/sessions/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...metadata,
          scope: action.scope,
          ...(action.targetHandle === undefined ? {} : { targetHandle: action.targetHandle }),
          confirmed: true,
          currentPassword
        })
      });
      const { body, data } = await responseData(response);
      if (accountScopeRef.current !== accountScope) return;
      if (!response.ok || body?.ok !== true) {
        const status = await checkStatus(metadata);
        if (accountScopeRef.current !== accountScope) return;
        reconciliationAttempted = true;
        if (status === "terminal") {
          await finishTerminalReconciliation(action);
          return;
        }
        if (action.scope === "current" || action.scope === "all") {
          router.push("/login");
          router.refresh();
          return;
        }
        throw new Error(body?.error?.message ?? "The session sign-out result is unknown. Check again before retrying.");
      }
      if (data?.status !== "revoked" && data?.status !== "already_revoked" && data?.status !== "stale_security_version") {
        await checkStatus(metadata);
        if (accountScopeRef.current !== accountScope) return;
        throw new Error("The session sign-out result is unknown. Check again before retrying.");
      }
      if (accountScopeRef.current !== accountScope) return;
      sessionStorage.removeItem(operationStorageKey);
      if (data.status === "stale_security_version") throw new Error("Your security state changed. Sign in again before retrying.");
      closeConfirmation();
      if (data.signedOut === true || action.scope === "current" || action.scope === "all") {
        router.push("/login");
        router.refresh();
      } else {
        await load();
      }
    } catch (error) {
      if (accountScopeRef.current !== accountScope) return;
      if (metadata && !reconciliationAttempted) {
        const status = await checkStatus(metadata);
        if (accountScopeRef.current !== accountScope) return;
        if (status === "terminal") {
          await finishTerminalReconciliation(action);
          return;
        }
        if (action.scope === "current" || action.scope === "all") {
          router.push("/login");
          router.refresh();
          return;
        }
      }
      setMessage(error instanceof Error ? error.message : "The session sign-out result is unknown. Check again before retrying.");
    } finally {
      if (accountScopeRef.current === accountScope) setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="active-sessions-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 ref={headingRef} id="active-sessions-heading" tabIndex={-1} className="font-editorial text-xl font-bold">Active sessions</h2>
          <p className="text-sm text-muted-foreground">Review and securely sign out browsers using your Cubby account.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-primary">
            <Link href="/account/security" className="underline-offset-4 hover:underline">Manage account security</Link>
            <Link href="/app/settings/security-history" className="underline-offset-4 hover:underline">View security history</Link>
          </div>
        </div>
        {loadState === "ready" && sessions.length > 0 ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            {sessions.some((session) => !session.isCurrent) ? (
              <Button variant="secondary" onClick={(event) => openConfirmation({ scope: "others", label: "other devices" }, event.currentTarget)} disabled={busy}>Sign out other devices</Button>
            ) : null}
            <Button variant="secondary" onClick={(event) => openConfirmation({ scope: "all", label: "all devices" }, event.currentTarget)} disabled={busy}>Sign out all devices</Button>
          </div>
        ) : null}
      </div>

      {loadState === "loading" ? <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">Loading active sessions...</p> : null}
      {loadState === "error" ? (
        <div className="space-y-3 rounded-lg border border-danger/35 bg-danger/10 p-4">
          <p role="alert" className="text-sm text-danger">{message || "Sessions could not be loaded."}</p>
          <Button variant="secondary" onClick={() => void load()} disabled={busy}>Try again</Button>
        </div>
      ) : null}
      {loadState === "ready" && sessions.length === 0 ? <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">No active sessions found.</p> : null}

      {loadState === "ready" && sessions.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {sessions.map((session) => (
            <li key={session.handle} className="min-w-0 rounded-lg border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary"><MonitorSmartphone className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words font-bold">{session.deviceLabel}</h3>
                    {session.isCurrent ? <span className="rounded-full bg-primary/14 px-2 py-0.5 text-xs font-bold text-primary">Current device</span> : null}
                  </div>
                  <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
                    <div><dt className="inline font-semibold text-foreground">Signed in: </dt><dd className="inline">{dateLabel(session.createdAt)}</dd></div>
                    <div><dt className="inline font-semibold text-foreground">Last active: </dt><dd className="inline">{dateLabel(session.lastQualifyingAt)}</dd></div>
                    <div><dt className="inline font-semibold text-foreground">Expires: </dt><dd className="inline">{dateLabel(session.expiresAt)}</dd></div>
                    {session.idleWarningAt ? <div><dt className="inline font-semibold text-foreground">Idle warning: </dt><dd className="inline">{dateLabel(session.idleWarningAt)}</dd></div> : null}
                  </dl>
                  <Button className="mt-3 w-full sm:w-auto" variant="secondary" onClick={(event) => openConfirmation({ scope: session.isCurrent ? "current" : "one", targetHandle: session.handle, label: session.isCurrent ? "this device" : session.deviceLabel }, event.currentTarget)} disabled={busy}>
                    {session.isCurrent ? "Sign out this device" : "Sign out this session"}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {confirmation ? (
        <div role="region" aria-label="Confirm session sign-out" className="space-y-3 rounded-lg border border-danger/35 bg-danger/10 p-4">
          <div>
            <h3 className="font-bold">Confirm sign out of {confirmation.label}</h3>
            <p className="text-sm text-muted-foreground">Enter your current password. This action may immediately end one or more active sessions.</p>
          </div>
          <div className="space-y-1">
            <label htmlFor="session-current-password" className="text-sm font-semibold">Current password</label>
            <input ref={passwordRef} id="session-current-password" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base" />
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={closeConfirmation} disabled={busy}>Cancel</Button>
            <Button onClick={() => void confirmRevoke()} disabled={busy || password.length === 0}>{busy ? "Checking status..." : "Confirm sign out"}</Button>
          </div>
        </div>
      ) : null}

      <div aria-live="polite" aria-atomic="true">
        {message && loadState === "ready" ? <p role="alert" className="text-sm text-danger">{message}</p> : null}
      </div>
    </section>
  );
}
