"use client";

import { useEffect, useState } from "react";
import { activeTimerElapsedSeconds, formatTimerElapsed, timerElapsedSpoken, type ActiveTimerLike } from "@/lib/active-timer";

/**
 * A running timer's elapsed time, ticking once a second, and the dot that says it is live. Shared by
 * the dashboard tiles and the shell's timer bar so both always read the same.
 */

export function TimerElapsed({ timer, nowMs, className }: { timer: ActiveTimerLike; nowMs: number; className?: string }) {
  // The first client render must match the server's, so the clock only starts after mount.
  const [now, setNow] = useState(nowMs);
  const paused = timer.timerState === "paused";

  useEffect(() => {
    setNow(Date.now());
    if (paused) return;
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, [paused, timer.startedAt, timer.pausedAt, timer.pausedSeconds]);

  const seconds = activeTimerElapsedSeconds(timer, now);
  return (
    <span className={className}>
      {/* The digits change every second, so assistive technology is given the duration in words once
          instead of a live region that would talk over everything else. */}
      <span aria-hidden="true" className="tabular-nums">{formatTimerElapsed(seconds)}</span>
      <span className="sr-only">{paused ? "Paused at " : "Running for "}{timerElapsedSpoken(seconds)}</span>
    </span>
  );
}

/** Filled while running, a hollow ring while paused. */
export function TimerDot({ paused }: { paused: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        paused
          ? "inline-block h-2 w-2 shrink-0 rounded-full border-2 border-live"
          : "inline-block h-2 w-2 shrink-0 rounded-full bg-live"
      }
    />
  );
}
