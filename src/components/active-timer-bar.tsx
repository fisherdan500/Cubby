"use client";

import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { StopTimerButton } from "@/components/actions/activity-actions";
import { ActivityArtwork } from "@/components/activity-artwork";
import { TimerDot, TimerElapsed } from "@/components/timer-elapsed";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { ACTIVE_TIMERS_CHANGED_EVENT, activeTimerActionLabel } from "@/lib/active-timer";
import { canonicalTimerReturnTo } from "@/lib/activity-navigation";
import { createFreshnessRequestToken, FRESHNESS_REQUESTED_EVENT } from "@/lib/app-freshness";
import { useRegisterTimerRetry, useReportTimerFreshness } from "@/components/app-freshness";
import type { ActiveTimerSummary } from "@/server/services/active-timers";

/**
 * One line above the bottom navigation, carrying the thing you actually need in a hurry: how long a
 * timer has been going, and Stop. It shows on the Log screen, with every running timer, and on a
 * running activity's own screens, with that activity's timer - nowhere else: not over another
 * activity's form, and not on Moments, Calendar or Reports, where it only got in the way.
 *
 * Pause is deliberately not here - it is far rarer than stop, and it lives on the activity's own
 * screen, where there is room to think.
 */

function timerHref(timer: ActiveTimerSummary, returnTo: string) {
  return `/app/activities/${timer.id}?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * On one activity's own screen - logging, viewing or editing it - `activityType` is that activity, and
 * only a timer of the same activity shows: a running sleep never sits over a diaper's buttons.
 */
export function ActiveTimerBar({ selectedBabyId, activityType }: { selectedBabyId?: string; activityType?: string }) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const [snapshot, setSnapshot] = useState<{ babyId?: string; timers: ActiveTimerSummary[] }>({ babyId: selectedBabyId, timers: [] });
  const lastConfirmation = useRef<{
    babyId?: string;
    at: string | null;
    stale: boolean;
    targets: { id: string; timerState: "running" | "paused" }[] | null;
  }>({ babyId: selectedBabyId, at: null, stale: false, targets: null });
  const allTimers = snapshot.babyId === selectedBabyId ? snapshot.timers : [];
  const [pending, setPending] = useState(true);
  const [stale, setStale] = useState(false);
  const descriptionId = useId();
  const reportFreshness = useReportTimerFreshness();
  const registerRetry = useRegisterTimerRetry();
  const timers = activityType ? allTimers.filter((timer) => timer.type === activityType) : allTimers;
  const [nowMs, setNowMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const search = searchParams.toString();
  const returnTo = canonicalTimerReturnTo(search ? `${pathname}?${search}` : pathname);

  // Asked for on arrival and on every navigation, so stopping a timer anywhere clears the bar
  // everywhere, and a timer another caregiver started shows up on the next screen you open.
  useEffect(() => {
    let current = true;
    let loadVersion = 0;
    let confirmedAt = lastConfirmation.current.babyId === selectedBabyId ? lastConfirmation.current.at : null;
    let targets = lastConfirmation.current.babyId === selectedBabyId ? lastConfirmation.current.targets : null;
    let abort: AbortController | undefined;
    let deadline: number | undefined;
    const fail = () => {
      lastConfirmation.current = { babyId: selectedBabyId, at: confirmedAt, stale: true, targets };
      setPending(false);
      setStale(true);
      reportFreshness?.({ babyId: selectedBabyId, pending: false, stale: true, confirmedAt, targets });
    };
    const offline = () => { ++loadVersion; abort?.abort(); window.clearTimeout(deadline); fail(); };
    async function load() {
      if (!current) return;
      const currentLoad = ++loadVersion;
      abort?.abort();
      window.clearTimeout(deadline);
      const stale = lastConfirmation.current.babyId === selectedBabyId && lastConfirmation.current.stale;
      setPending(true);
      setStale(stale);
      reportFreshness?.({ babyId: selectedBabyId, pending: true, stale, confirmedAt, targets });
      const controller = new AbortController();
      abort = controller;
      deadline = window.setTimeout(() => {
        if (current && currentLoad === loadVersion) {
          ++loadVersion;
          controller.abort();
          fail();
        }
      }, 10_000);
      try {
        const requestToken = createFreshnessRequestToken();
        const search = new URLSearchParams({ requestToken });
        if (selectedBabyId) search.set("babyId", selectedBabyId);
        const endpoint = `/api/timers/active?${search}`;
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        const body = response.ok ? await response.json() : null;
        if (!current || currentLoad !== loadVersion) return;
        const snapshot = activeTimerSnapshot.parse(body);
        if (snapshot.data.requestToken !== requestToken) throw new Error("unconfirmed_snapshot");
        if (!navigator.onLine) throw new Error("offline");
        if (confirmedAt && Date.parse(snapshot.data.confirmedAt) < Date.parse(confirmedAt)) throw new Error("unconfirmed_snapshot");
        confirmedAt = snapshot.data.confirmedAt;
        targets = snapshot.data.timers
          .filter((timer) => !selectedBabyId || timer.babyId === selectedBabyId)
          .map(({ id, timerState }) => ({ id, timerState }));
        lastConfirmation.current = { babyId: selectedBabyId, at: confirmedAt, stale: false, targets };
        setSnapshot({ babyId: selectedBabyId, timers: snapshot.data.timers });
        setPending(false);
        setStale(false);
        reportFreshness?.({ babyId: selectedBabyId, pending: false, stale: false, confirmedAt, targets });
        setNowMs(Date.now());
      } catch {
        if (current && currentLoad === loadVersion) fail();
      } finally {
        if (currentLoad === loadVersion) window.clearTimeout(deadline);
      }
    }
    const onTimerChanged = () => { void load(); };
    const unregisterRetry = registerRetry?.(onTimerChanged);
    window.addEventListener(ACTIVE_TIMERS_CHANGED_EVENT, onTimerChanged);
    window.addEventListener(FRESHNESS_REQUESTED_EVENT, onTimerChanged);
    window.addEventListener("offline", offline);
    void load();
    return () => {
      current = false;
      unregisterRetry?.();
      abort?.abort();
      window.clearTimeout(deadline);
      reportFreshness?.(null);
      window.removeEventListener(ACTIVE_TIMERS_CHANGED_EVENT, onTimerChanged);
      window.removeEventListener(FRESHNESS_REQUESTED_EVENT, onTimerChanged);
      window.removeEventListener("offline", offline);
    };
  }, [pathname, selectedBabyId, reportFreshness, registerRetry]);

  const visible = timers.length > 0;

  // Anything pinned to the bottom of a screen offsets itself by this, so the bar never covers it.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--active-timer-bar", visible ? "3.5rem" : "0rem");
    return () => root.style.setProperty("--active-timer-bar", "0rem");
  }, [visible]);

  if (!visible) return null;

  const [first, ...rest] = timers;
  const firstType = first.type as ActivityTypeName;
  const disabled = pending || stale;
  const explanation = stale
    ? pending
      ? "Timer data may be out of date and is refreshing. Timer actions are unavailable until refresh completes."
      : "Timer data may be out of date. Timer actions are unavailable until refreshed."
    : "Timer data is refreshing. Timer actions are unavailable until refresh completes.";

  // Directly above the phone's bottom navigation, matching the activity action bar's offset.
  return (
    <div className="fixed inset-x-0 bottom-[4.75rem] z-30 px-3 md:bottom-4 md:left-64 md:px-6 print:hidden">
      <section
        aria-label="Running timers"
        aria-describedby={disabled ? descriptionId : undefined}
        className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-live/35 bg-card/97 shadow-lift backdrop-blur"
      >
        {disabled ? <p id={descriptionId} className="sr-only">{explanation}</p> : null}
        <div className="flex items-center gap-2 p-2">
          <TimerDot paused={first.timerState === "paused"} />
          {stale ? <a href="#app-freshness-status" aria-label="Timer data may be out of date; view refresh status" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-foreground">!</a> : null}
          <ActivityArtwork type={firstType} size="xs" />
          <Link
            href={timerHref(first, returnTo)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-sm transition hover:bg-muted"
          >
            <span className="truncate font-semibold text-foreground">{first.babyName} · {activityLabels[firstType]}</span>
            <span className="font-bold text-muted-foreground">
              <span aria-hidden="true">{first.timerState === "paused" ? "Paused at " : ""}</span>
              <TimerElapsed timer={first} nowMs={nowMs} />
            </span>
          </Link>
          {rest.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              aria-controls="active-timer-list"
              className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-primary transition hover:bg-muted"
            >
              {expanded ? "Show fewer" : (
                <>
                  +{rest.length}
                  <span className="sr-only"> more running timers, show all</span>
                </>
              )}
            </button>
          ) : null}
          <fieldset disabled={disabled} aria-describedby={disabled ? descriptionId : undefined}>
            <StopTimerButton
              id={first.id}
              accessibleLabel={activeTimerActionLabel("Stop", first.babyName, activityLabels[firstType], first, timers)}
            />
          </fieldset>
        </div>

        {expanded && rest.length > 0 ? (
          <ul
            id="active-timer-list"
            className="max-h-[calc(100dvh-10rem)] divide-y divide-border overflow-y-auto overscroll-contain border-t border-border md:max-h-[calc(100dvh-6rem)]"
          >
            {rest.map((timer) => (
              <li key={timer.id} className="flex items-center gap-2 p-2">
                <TimerDot paused={timer.timerState === "paused"} />
                <ActivityArtwork type={timer.type as ActivityTypeName} size="xs" />
                <Link
                  href={timerHref(timer, returnTo)}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-lg px-1 transition hover:bg-muted"
                >
                  <span className="truncate text-sm font-semibold text-foreground">
                    {timer.babyName} · {activityLabels[timer.type as ActivityTypeName]}
                  </span>
                  <span className="truncate text-xs font-semibold text-muted-foreground">
                    <span aria-hidden="true">{timer.timerState === "paused" ? "Paused at " : ""}</span>
                    <TimerElapsed timer={timer} nowMs={nowMs} />
                  </span>
                </Link>
                <fieldset disabled={disabled} aria-describedby={disabled ? descriptionId : undefined}>
                  <StopTimerButton
                    id={timer.id}
                    accessibleLabel={activeTimerActionLabel(
                      "Stop",
                      timer.babyName,
                      activityLabels[timer.type as ActivityTypeName],
                      timer,
                      timers
                    )}
                  />
                </fieldset>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

const activeTimerSnapshot = z.object({
  ok: z.literal(true),
  data: z.object({
    requestToken: z.uuid(),
    confirmedAt: z.iso.datetime(),
    timers: z.array(z.object({
      id: z.string().min(1), babyId: z.string().min(1), babyName: z.string().min(1),
      type: z.enum(["sleep", "feeding", "pumping", "play"]),
      timerState: z.enum(["running", "paused"]),
      startedAt: z.iso.datetime().nullable(), pausedAt: z.iso.datetime().nullable(),
      pausedSeconds: z.number().nonnegative()
    }))
  })
});
