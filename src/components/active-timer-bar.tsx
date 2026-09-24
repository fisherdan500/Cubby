"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { StopTimerButton } from "@/components/actions/activity-actions";
import { ActivityArtwork } from "@/components/activity-artwork";
import { TimerDot, TimerElapsed } from "@/components/timer-elapsed";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { ACTIVE_TIMERS_CHANGED_EVENT, activeTimerActionLabel } from "@/lib/active-timer";
import { canonicalTimerReturnTo } from "@/lib/activity-navigation";
import type { ActiveTimerSummary } from "@/server/services/active-timers";

/**
 * One line above the bottom navigation, whenever a timer is running, carrying the thing you actually
 * need in a hurry: how long it has been going, and Stop.
 *
 * It lives in the shell rather than on the dashboard because the moment a feed ends is rarely the
 * moment you happen to be looking at the dashboard. Pause is deliberately not here - it is far rarer
 * than stop, and it lives on the activity's own screen, where there is room to think.
 */

function timerHref(timer: ActiveTimerSummary, returnTo: string) {
  return `/app/activities/${timer.id}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function ActiveTimerBar({ selectedBabyId }: { selectedBabyId?: string }) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const [timers, setTimers] = useState<ActiveTimerSummary[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const search = searchParams.toString();
  const returnTo = canonicalTimerReturnTo(search ? `${pathname}?${search}` : pathname);

  // Asked for on arrival and on every navigation, so stopping a timer anywhere clears the bar
  // everywhere, and a timer another caregiver started shows up on the next screen you open.
  useEffect(() => {
    let current = true;
    let loadVersion = 0;
    async function load() {
      const currentLoad = ++loadVersion;
      try {
        const endpoint = selectedBabyId
          ? `/api/timers/active?babyId=${encodeURIComponent(selectedBabyId)}`
          : "/api/timers/active";
        const response = await fetch(endpoint, { cache: "no-store" });
        const body = response.ok ? await response.json() : null;
        if (!current || currentLoad !== loadVersion) return;
        setTimers(activeTimersFromResponse(body));
        setNowMs(Date.now());
      } catch {
        // The bar is an affordance, never a gate: if it cannot be loaded, it simply is not there.
        if (current && currentLoad === loadVersion) setTimers([]);
      }
    }
    const onTimerChanged = () => { void load(); };
    window.addEventListener(ACTIVE_TIMERS_CHANGED_EVENT, onTimerChanged);
    void load();
    return () => {
      current = false;
      window.removeEventListener(ACTIVE_TIMERS_CHANGED_EVENT, onTimerChanged);
    };
  }, [pathname, selectedBabyId]);

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

  // Directly above the phone's bottom navigation, matching the activity action bar's offset.
  return (
    <div className="fixed inset-x-0 bottom-[4.75rem] z-30 px-3 md:bottom-4 md:left-64 md:px-6">
      <section
        aria-label="Running timers"
        className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-live/35 bg-card/97 shadow-lift backdrop-blur"
      >
        <div className="flex items-center gap-2 p-2">
          <TimerDot paused={first.timerState === "paused"} />
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
          <StopTimerButton
            id={first.id}
            accessibleLabel={activeTimerActionLabel("Stop", first.babyName, activityLabels[firstType], first, timers)}
          />
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
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function activeTimersFromResponse(body: unknown) {
  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("data" in body)) return [];
  const data = body.data;
  if (!data || typeof data !== "object" || !("timers" in data) || !Array.isArray(data.timers)) return [];
  return data.timers as ActiveTimerSummary[];
}
