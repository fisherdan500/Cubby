"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatInstant } from "@/lib/timezone";

type Incident = {
  windowStartedAt: string;
  windowEndedAt: string;
  approximateFailures: "5-9" | "10-19" | "20-49" | "50+";
  guidance: readonly string[];
};

type SecurityEvent = {
  handle: string;
  eventClass: string;
  action: string;
  outcome: string;
  occurredAt: string;
  operationKey?: string;
  incident?: Incident;
};

type HistoryResponse = { ok?: boolean; data?: { events?: SecurityEvent[]; nextCursor?: string | null }; error?: { message?: string } };
const exportFilename = "cubby-global-security-history-v1-UTC.json";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateLabel(value: string, timeZone: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : formatInstant(date, timeZone);
}

async function historyResponse(response: Response) {
  return response.json().catch(() => null) as Promise<HistoryResponse | null>;
}

export function SecurityHistory({ accountScope, timeZone, headingLevel = 1 }: { accountScope: string; timeZone: string; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const Subheading = headingLevel === 1 ? "h2" : "h3";
  const activeAccountScopeRef = useRef(accountScope);
  const [stateAccountScope, setStateAccountScope] = useState(accountScope);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmingExport, setConfirmingExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const cancelExportRef = useRef<HTMLButtonElement>(null);
  const restoreExportFocus = useRef(false);

  async function load(requestScope: string, cursor?: string) {
    const response = await fetch(`/api/account/security-history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
    const body = await historyResponse(response);
    if (activeAccountScopeRef.current !== requestScope) return false;
    if (!response.ok || body?.ok !== true || !Array.isArray(body.data?.events)) throw new Error(body?.error?.message ?? "Security history could not be loaded.");
    setEvents((current) => cursor ? [...current, ...body.data!.events!] : body.data!.events!);
    setNextCursor(typeof body.data?.nextCursor === "string" ? body.data.nextCursor : null);
    return true;
  }

  async function loadInitial(requestScope = accountScope) {
    if (activeAccountScopeRef.current !== requestScope) return;
    setState("loading");
    setMessage("");
    try {
      if (!(await load(requestScope))) return;
      setState("ready");
    } catch (error) {
      if (activeAccountScopeRef.current !== requestScope) return;
      setEvents([]);
      setNextCursor(null);
      setState("error");
      setMessage(error instanceof Error ? error.message : "Security history could not be loaded.");
    }
  }

  useEffect(() => {
    const effectScope = accountScope;
    activeAccountScopeRef.current = effectScope;
    setStateAccountScope(effectScope);
    setEvents([]);
    setNextCursor(null);
    setMessage("");
    setConfirmingExport(false);
    void loadInitial(effectScope);
    return () => { if (activeAccountScopeRef.current === effectScope) activeAccountScopeRef.current = ""; };
    // `loadInitial` deliberately captures this exact account scope and rejects late responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountScope]);
  useEffect(() => {
    if (confirmingExport) cancelExportRef.current?.focus();
    else if (restoreExportFocus.current) {
      restoreExportFocus.current = false;
      exportButtonRef.current?.focus();
    }
  }, [confirmingExport]);

  async function loadMore() {
    if (!nextCursor) return;
    const requestScope = accountScope;
    setLoadingMore(true);
    setMessage("");
    try {
      if (!(await load(requestScope, nextCursor))) return;
      setMessageKind("success");
      setMessage("More security history loaded.");
    } catch (error) {
      if (activeAccountScopeRef.current !== requestScope) return;
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : "More security history could not be loaded.");
    } finally {
      if (activeAccountScopeRef.current === requestScope) setLoadingMore(false);
    }
  }

  async function exportHistory() {
    const requestScope = accountScope;
    setExporting(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/security-history/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true })
      });
      if (activeAccountScopeRef.current !== requestScope) return;
      if (!response.ok) {
        const body = await historyResponse(response);
        throw new Error(body?.error?.message ?? "Security history could not be exported.");
      }
      const blob = await response.blob();
      if (activeAccountScopeRef.current !== requestScope) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportFilename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setConfirmingExport(false);
      setMessageKind("success");
      setMessage("Your security history export is ready.");
    } catch (error) {
      if (activeAccountScopeRef.current !== requestScope) return;
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : "Security history could not be exported.");
    } finally {
      if (activeAccountScopeRef.current === requestScope) {
        setExporting(false);
        restoreExportFocus.current = true;
        setConfirmingExport(false);
      }
    }
  }

  const scopeIsCurrent = stateAccountScope === accountScope;

  return (
    <section className="space-y-4" aria-labelledby="security-history-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Heading id="security-history-heading" className="font-editorial text-2xl font-bold">Security history</Heading>
          <p className="mt-1 text-sm text-muted-foreground">Review private account-security events. This history does not include household activity.</p>
        </div>
        <Button ref={exportButtonRef} variant="secondary" onClick={() => setConfirmingExport(true)} disabled={!scopeIsCurrent || state !== "ready" || exporting}>
          <Download className="mr-2 h-4 w-4" aria-hidden="true" />Export history
        </Button>
      </div>

      {scopeIsCurrent && confirmingExport ? (
        <div role="region" aria-label="Confirm security history export" className="space-y-3 rounded-lg border border-primary/35 bg-primary/10 p-4">
          <div>
            <Subheading className="font-bold">Export private security history?</Subheading>
            <p className="text-sm text-muted-foreground">This downloads your account-security events as a JSON file.</p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button ref={cancelExportRef} type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50" onClick={() => { restoreExportFocus.current = true; setConfirmingExport(false); }} disabled={exporting}>Cancel</button>
            <Button onClick={() => void exportHistory()} disabled={exporting}>{exporting ? "Preparing export..." : "Download export"}</Button>
          </div>
        </div>
      ) : null}

      {scopeIsCurrent && state === "loading" ? <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">Loading security history...</p> : null}
      {scopeIsCurrent && state === "error" ? <div className="space-y-3 rounded-lg border border-danger/35 bg-danger/10 p-4"><p role="alert" className="text-sm text-danger">{message || "Security history could not be loaded."}</p><Button variant="secondary" onClick={() => void loadInitial()}>Try again</Button></div> : null}
      {scopeIsCurrent && state === "ready" && events.length === 0 ? <p className="rounded-lg border border-border bg-surface-soft p-4 text-sm text-muted-foreground">No security history is available yet.</p> : null}

      {scopeIsCurrent && state === "ready" && events.length > 0 ? (
        <ol className="space-y-3" aria-label="Security history events">
          {events.map((event) => (
            <li key={event.handle} className="rounded-lg border border-border bg-card p-4">
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <Subheading className="font-bold">{label(event.action)}</Subheading>
                  <p className="text-sm text-muted-foreground">{label(event.outcome)} · {dateLabel(event.occurredAt, timeZone)}</p>
                  {event.operationKey ? <p className="mt-1 text-xs text-muted-foreground">Operation: {label(event.operationKey)}</p> : null}
                  {event.incident ? <p className="mt-2 text-sm text-muted-foreground">Sign-in protection window: approximately {event.incident.approximateFailures} failed attempts. Consider changing your password and reviewing active sessions.</p> : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {scopeIsCurrent && state === "ready" && nextCursor ? <Button variant="secondary" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading more..." : "Load more"}</Button> : null}
      <div aria-live="polite" aria-atomic="true">{scopeIsCurrent && message && state === "ready" ? <p className={messageKind === "error" ? "text-sm text-danger" : "text-sm text-success"} role={messageKind === "error" ? "alert" : "status"}>{message}</p> : null}</div>
    </section>
  );
}
