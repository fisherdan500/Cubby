"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { StopTimerButton } from "@/components/actions/activity-actions";
import { ActivityArtwork } from "@/components/activity-artwork";
import { TimerDot, TimerElapsed } from "@/components/timer-elapsed";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import type { ActiveTimerSummary } from "@/server/services/active-timers";

/**
 * One line above the bottom navigation, whenever a timer is running, carrying the thing you actually
 * need in a hurry: how long it has been going, and Stop.
 *
 * It lives in the shell rather than on the dashboard because the moment a feed ends is rarely the
 * moment you happen to be looking at the dashboard. Pause is deliberately not here - it is far rarer
 * than stop, and it lives on the activity's own screen, where there is room to think.
 *
 * The Nursery screen already gives every timer full-size night controls, so the bar stands aside there
 * rather than stacking a second set on top of them.
 */

const HIDDEN_ON = ["/app/nursery"];

function timerHref(timer: ActiveTimerSummary, pathname: string) {
  return `/app/activities/${timer.id}?returnTo=${encodeURIComponent(pathname)}`;
}

export function ActiveTimerBar() {
  const pathname = usePathname() ?? "";
  const [timers, setTimers] = useState<ActiveTimerSummary[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Asked for on arrival and on every navigation, so stopping a timer anywhere clears the bar
  // everywhere, and a timer another caregiver started shows up on the next screen you open.
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const response = await fetch("/api/timers/active", { cache: "no-store" });
        const body = response.ok ? ((await response.json()) as { timers?: ActiveTimerSummary[] }) : { timers: [] };
        if (!current) return;
        setTimers(body.timers ?? []);
        setNowMs(Date.now());
      } catch {
        // The bar is an affordance, never a gate: if it cannot be loaded, it simply is not there.
        if (current) setTimers([]);
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [pathname]);

  const visible = timers.length > 0 && !HIDDEN_ON.some((route) => pathname.startsWith(route));

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
        className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-primary/40 bg-card/97 shadow-soft backdrop-blur"
      >
        {expanded ? (
          <ul className="divide-y divide-border">
            {timers.map((timer) => (
              <li key={timer.id} className="flex items-center gap-2 p-2">
                <TimerDot paused={timer.timerState === "paused"} />
                <ActivityArtwork type={timer.type as ActivityTypeName} size="xs" />
                <Link
                  href={timerHref(timer, pathname)}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-lg px-1 transition hover:bg-muted"
                >
                  <span className="truncate text-sm font-black text-foreground">
                    {activityLabels[timer.type as ActivityTypeName]}
                  </span>
                  <span className="truncate text-xs font-semibold text-muted-foreground">
                    <span aria-hidden="true">{timer.timerState === "paused" ? "Paused at " : ""}</span>
                    <TimerElapsed timer={timer} nowMs={nowMs} />
                  </span>
                </Link>
                <StopTimerButton id={timer.id} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 p-2">
            <TimerDot paused={first.timerState === "paused"} />
            <ActivityArtwork type={firstType} size="xs" />
            <Link
              href={timerHref(first, pathname)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-sm transition hover:bg-muted"
            >
              <span className="truncate font-black text-foreground">{activityLabels[firstType]}</span>
              <span className="font-bold text-muted-foreground">
                <span aria-hidden="true">{first.timerState === "paused" ? "Paused at " : ""}</span>
                <TimerElapsed timer={first} nowMs={nowMs} />
              </span>
            </Link>
            {rest.length > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-expanded={false}
                className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-black text-primary transition hover:bg-muted"
              >
                +{rest.length}
                <span className="sr-only"> more running timers, show all</span>
              </button>
            ) : null}
            <StopTimerButton id={first.id} />
          </div>
        )}

        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded
            className="flex min-h-11 w-full items-center justify-center border-t border-border text-xs font-black text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            Show fewer
          </button>
        ) : null}
      </section>
    </div>
  );
}
