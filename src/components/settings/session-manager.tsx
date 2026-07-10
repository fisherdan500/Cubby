"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MonitorSmartphone, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { isSessionReauthenticationRequired } from "@/lib/auth/client-errors";
import { sessionDateLabel, sessionDeviceLabel } from "@/lib/auth/session-display";

type SessionRow = {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  userAgent?: string | null;
  ipAddress?: string | null;
};

type LoadState = "loading" | "ready" | "reauthentication" | "error";

export function SessionManager() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setMessage("");
    try {
      const [sessionsResult, currentResult] = await Promise.all([
        authClient.listSessions(),
        authClient.getSession()
      ]);
      if (sessionsResult.error) {
        setSessions([]);
        setLoadState(isSessionReauthenticationRequired(sessionsResult.error) ? "reauthentication" : "error");
        if (!isSessionReauthenticationRequired(sessionsResult.error)) {
          setMessage(sessionsResult.error.message ?? "Sessions could not be loaded.");
        }
        return;
      }

      const current = currentResult.data as { session?: { token?: string } } | null;
      const token = current?.session?.token ?? null;
      const loaded = (sessionsResult.data ?? []) as SessionRow[];
      setCurrentToken(token);
      setSessions(
        [...loaded].sort((left, right) => {
          if (left.token === token) return -1;
          if (right.token === token) return 1;
          return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        })
      );
      setLoadState("ready");
    } catch {
      setSessions([]);
      setLoadState("error");
      setMessage("Sessions could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signInAgain() {
    setBusyAction("reauthenticate");
    await authClient.signOut().catch(() => undefined);
    router.push(`/login?next=${encodeURIComponent("/app/settings/sessions")}`);
    router.refresh();
  }

  async function revoke(session: SessionRow) {
    setBusyAction(session.token);
    setMessage("");
    try {
      if (session.token === currentToken) {
        const signOutResult = await authClient.signOut();
        if (signOutResult.error) {
          setMessage(signOutResult.error.message ?? "This device could not be signed out.");
          return;
        }
        router.push("/login");
        router.refresh();
        return;
      }

      const result = await authClient.revokeSession({ token: session.token });
      if (result.error) {
        setLoadState(isSessionReauthenticationRequired(result.error) ? "reauthentication" : "error");
        setMessage(result.error.message ?? "The session could not be revoked.");
        return;
      }
      await load();
    } catch {
      setMessage("The session could not be revoked.");
    } finally {
      setBusyAction(null);
    }
  }

  async function revokeOtherSessions() {
    setBusyAction("others");
    setMessage("");
    try {
      const result = await authClient.revokeOtherSessions();
      if (result.error) {
        setLoadState(isSessionReauthenticationRequired(result.error) ? "reauthentication" : "error");
        setMessage(result.error.message ?? "Other sessions could not be revoked.");
        return;
      }
      await load();
    } catch {
      setMessage("Other sessions could not be revoked.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-editorial text-xl font-bold">Active sessions</h2>
          <p className="text-sm text-muted-foreground">Review browsers signed into your Cubby account.</p>
        </div>
        {loadState === "ready" && sessions.length > 1 ? (
          <Button variant="secondary" onClick={() => void revokeOtherSessions()} disabled={busyAction !== null}>
            Sign out other devices
          </Button>
        ) : null}
      </div>

      {loadState === "loading" ? (
        <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">Loading active sessions...</p>
      ) : null}

      {loadState === "reauthentication" ? (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <p className="font-bold">Sign in again to manage sessions</p>
              <p className="text-sm text-muted-foreground">
                For security, Cubby allows session review and revocation for 10 minutes after signing in.
              </p>
            </div>
          </div>
          <Button onClick={() => void signInAgain()} disabled={busyAction !== null}>
            {busyAction === "reauthenticate" ? "Signing out..." : "Sign in again"}
          </Button>
        </div>
      ) : null}

      {loadState === "error" ? (
        <div className="space-y-3 rounded-lg border border-danger/35 bg-danger/10 p-4">
          <p className="text-sm text-danger">{message || "Sessions could not be loaded."}</p>
          <Button variant="secondary" onClick={() => void load()} disabled={busyAction !== null}>
            Try again
          </Button>
        </div>
      ) : null}

      {loadState === "ready" && sessions.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">No active sessions found.</p>
      ) : null}

      {loadState === "ready" && sessions.length ? (
        <div className="space-y-3">
          {sessions.map((session) => {
            const current = session.token === currentToken;
            return (
              <div key={session.id || session.token} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <MonitorSmartphone className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold" title={session.userAgent ?? undefined}>{sessionDeviceLabel(session.userAgent)}</p>
                      {current ? <span className="rounded-full bg-primary/14 px-2 py-0.5 text-xs font-bold text-primary">Current</span> : null}
                    </div>
                    <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div><dt className="inline font-semibold text-foreground">IP: </dt><dd className="inline">{session.ipAddress || "Unavailable"}</dd></div>
                      <div><dt className="inline font-semibold text-foreground">Signed in: </dt><dd className="inline">{sessionDateLabel(session.createdAt)}</dd></div>
                      <div><dt className="inline font-semibold text-foreground">Expires: </dt><dd className="inline">{sessionDateLabel(session.expiresAt)}</dd></div>
                    </dl>
                    <Button
                      className="mt-3"
                      variant="secondary"
                      onClick={() => void revoke(session)}
                      disabled={busyAction !== null}
                    >
                      {busyAction === session.token ? "Signing out..." : current ? "Sign out this device" : "Revoke session"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {loadState === "ready" && message ? <p className="text-sm text-danger">{message}</p> : null}
    </section>
  );
}
