"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WifiOff } from "lucide-react";
import { FRESHNESS_REQUESTED_EVENT, type FreshnessRequest } from "@/lib/app-freshness";
import { formatInstant } from "@/lib/timezone";

type Confirmation = { token: string; confirmedAt: string };
type TimerFreshness = {
  babyId?: string;
  pending: boolean;
  stale: boolean;
  confirmedAt: string | null;
  targets: { id: string; timerState: "running" | "paused" }[] | null;
};
type Freshness = {
  stale: boolean;
  confirmedAt: string | null;
  confirm: (confirmation: Confirmation) => void;
  retry: () => void;
  timers: TimerFreshness | null;
  reportTimers: (state: TimerFreshness | null) => void;
  registerTimerRetry: (retry: () => void) => () => void;
};
const FreshnessContext = createContext<Freshness | null>(null);

export function AppFreshnessProvider({ children }: { children: React.ReactNode }) {
  const { refresh } = useRouter();
  const generation = useRef(0);
  const pending = useRef(false);
  const retryable = useRef(false);
  const timeout = useRef<number>();
  const foregroundTimeout = useRef<number>();
  const pollDelay = useRef<number>();
  const last = useRef<Confirmation | null>(null);
  const tokensAtInstant = useRef(new Set<string>());
  const receivedAt = useRef<number>(-Infinity);
  const [stale, setStale] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [timers, reportTimers] = useState<TimerFreshness | null>(null);
  const timerRetry = useRef<(() => void) | null>(null);
  const registerTimerRetry = useCallback((retry: () => void) => {
    timerRetry.current = retry;
    return () => { if (timerRetry.current === retry) timerRetry.current = null; };
  }, []);
  const confirm = useCallback((confirmation: Confirmation) => {
    if (!navigator.onLine || !Number.isFinite(Date.parse(confirmation.confirmedAt))) return;
    if (last.current && confirmation.confirmedAt < last.current.confirmedAt) return;
    if (last.current?.confirmedAt !== confirmation.confirmedAt) tokensAtInstant.current.clear();
    if (tokensAtInstant.current.has(confirmation.token)) return;
    tokensAtInstant.current.add(confirmation.token);
    last.current = confirmation;
    receivedAt.current = performance.now();
    pending.current = false;
    retryable.current = false;
    window.clearTimeout(timeout.current);
    window.clearTimeout(foregroundTimeout.current);
    setConfirmedAt(confirmation.confirmedAt);
    setStale(false);
  }, []);
  const request = useCallback((retry = false) => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    window.clearTimeout(foregroundTimeout.current);
    if (pending.current && !retryable.current) {
      if (retry) timerRetry.current?.();
      return;
    }
    if (!pending.current) {
      pending.current = true;
      window.dispatchEvent(new CustomEvent<FreshnessRequest>(FRESHNESS_REQUESTED_EVENT, {
        detail: { generation: ++generation.current }
      }));
    } else {
      // Reattempts keep the generation's single event, so reload client-owned timers directly.
      timerRetry.current?.();
    }
    retryable.current = false;
    window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => {
      retryable.current = true;
      setStale(true);
    }, 10_000);
    refresh();
  }, [refresh]);
  const retry = useCallback(() => request(true), [request]);
  useEffect(() => {
    let timer: number | undefined;
    // One per-client 14.5–15.0s cadence preserves the 20s SLO's five-second completion allowance.
    pollDelay.current ??= 14_500 + Math.floor(Math.random() * 501);
    const eligible = () => document.visibilityState === "visible" && navigator.onLine;
    const schedule = () => {
      window.clearInterval(timer);
      timer = eligible() ? window.setInterval(() => request(), pollDelay.current) : undefined;
    };
    const resume = () => {
      schedule();
      window.clearTimeout(foregroundTimeout.current);
      if (!eligible()) return;
      const remaining = 5_000 - (performance.now() - receivedAt.current);
      if (retryable.current || remaining <= 0) request();
      else foregroundTimeout.current = window.setTimeout(() => request(), remaining);
    };
    const offline = () => {
      retryable.current = pending.current;
      window.clearTimeout(timeout.current);
      window.clearTimeout(foregroundTimeout.current);
      setStale(true);
      schedule();
    };
    if (!navigator.onLine) setStale(true);
    schedule();
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(timeout.current);
      window.clearTimeout(foregroundTimeout.current);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [request]);
  const value = useMemo(() => ({ stale, confirmedAt, confirm, retry, timers, reportTimers, registerTimerRetry }), [stale, confirmedAt, confirm, retry, timers, registerTimerRetry]);
  return <FreshnessContext.Provider value={value}>{children}</FreshnessContext.Provider>;
}

export function useReportTimerFreshness() {
  return useContext(FreshnessContext)?.reportTimers;
}

export function useRegisterTimerRetry() {
  return useContext(FreshnessContext)?.registerTimerRetry;
}

export function TimerFreshnessGuard({ babyId, activityId, expectedTimerState, children }: {
  babyId: string;
  activityId: string;
  expectedTimerState: "running" | "paused";
  children?: React.ReactNode;
}) {
  const timers = useContext(FreshnessContext)?.timers;
  const descriptionId = useId();
  const matchesTarget = timers?.targets?.some((target) => target.id === activityId && target.timerState === expectedTimerState);
  const disabled = !timers || timers.babyId !== babyId || timers.pending || timers.stale || !timers.confirmedAt || !matchesTarget;
  let explanation = "Timer data has not yet been confirmed for this baby. Timer actions are unavailable until confirmed.";
  if (timers?.babyId === babyId) {
    if (timers.stale) {
      explanation = timers.pending
        ? "Timer data may be out of date and is refreshing. Timer actions are unavailable until refresh completes."
        : "Timer data may be out of date. Timer actions are unavailable until refreshed.";
    } else if (timers.pending) {
      explanation = timers.confirmedAt
        ? "Timer data is refreshing. Timer actions are unavailable until refresh completes."
        : "Timer data is being confirmed. Timer actions are unavailable until confirmation completes.";
    } else if (timers.confirmedAt && !matchesTarget) {
      explanation = "This activity's timer has not been confirmed in its displayed state. Timer actions are unavailable until the activity is refreshed.";
    }
  }
  return <fieldset disabled={disabled} aria-label="Timer actions" aria-describedby={disabled ? descriptionId : undefined} className="flex min-w-0 flex-wrap gap-2">
    {disabled ? <span id={descriptionId} className="sr-only">{explanation}</span> : null}
    {children}
  </fieldset>;
}

export function PageFreshness({ token, confirmedAt, timeZone }: Confirmation & { timeZone: string }) {
  const freshness = useContext(FreshnessContext);
  const confirm = freshness?.confirm;
  useEffect(() => { confirm?.({ token, confirmedAt }); }, [confirm, token, confirmedAt]);
  if (!freshness || (!freshness.stale && !freshness.timers?.stale)) return null;
  return (
    <div id="app-freshness-status" role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted p-3 text-sm text-foreground print:hidden">
      <WifiOff aria-hidden="true" className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {freshness.stale ? <>
          <p>Data may be out of date.</p>
          <p className="text-xs text-muted-foreground">Data current as of {freshness.confirmedAt
            ? <time dateTime={freshness.confirmedAt}>{formatInstant(freshness.confirmedAt, timeZone)}</time>
            : "not yet confirmed"}.</p>
        </> : null}
        {freshness.timers?.stale ? <>
          <p>Timer data may be out of date. Timer actions are unavailable.</p>
          <p className="text-xs text-muted-foreground">Data current as of {freshness.timers.confirmedAt
            ? <time dateTime={freshness.timers.confirmedAt}>{formatInstant(freshness.timers.confirmedAt, timeZone)}</time>
            : "not yet confirmed"}.</p>
        </> : null}
      </div>
      <button type="button" onClick={freshness.retry} className="min-h-11 rounded-lg px-3 font-semibold text-primary hover:bg-background">Retry refresh</button>
    </div>
  );
}
