"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * The red count over the Moments tab: how many moments arrived since this member last looked.
 *
 * The badge asks for its own count, the way the timer bar asks for its own timers: the shell is a
 * synchronous server component rendered by every signed-in page, and making all of chrome await a
 * count would put a database read on twenty pages for one dot. Silently zero on any failure -
 * chrome never takes a page down.
 *
 * Fetched on mount, on every route change, and on a steady cadence while the page is actually in
 * front of someone, so a moment posted by another member appears without needing a navigation. The
 * cadence follows the same rules as the rest of app freshness (see app-freshness.tsx): a jittered
 * interval so a household's open tabs do not arrive in lockstep, nothing at all while the tab is
 * hidden or the device is offline, and an immediate ask the moment either comes back - a phone in a
 * pocket spends no requests, and picking it up does not wait out the remaining interval.
 *
 * Rendered only when there is something to say - zero means no badge, not a grey zero - and capped
 * at 9+ so a week away does not become a four-digit scare. The aria-label carries the real number.
 * Navigating to Moments marks the feed seen server-side, and the re-fetch then clears the badge
 * without a reload.
 *
 * Also mirrors the count onto the installed app's icon where the platform supports it (Badging
 * API), clearing at zero so a read feed stops shouting.
 */

// One per-client 60.0-65.0s cadence: fast enough that a moment appears while someone is looking,
// slow enough that an idle tab costs a household one count request a minute.
const POLL_BASE_MS = 60_000;
const POLL_JITTER_MS = 5_000;
// A foreground return within this window of the last answer rides that answer instead of asking
// again, so an alt-tab burst does not become a burst of requests.
const FOREGROUND_MIN_GAP_MS = 5_000;

export function UnseenMomentsBadge({ placement }: { placement: "sidebar" | "tab" }) {
  const pathname = usePathname() ?? "";
  const [count, setCount] = useState(0);
  const inFlight = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const answeredAt = useRef<number>(-Infinity);
  const pollDelay = useRef<number>();
  const foregroundTimeout = useRef<number>();

  const load = useCallback(async () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const asked = ++generation.current;
    try {
      const response = await fetch("/api/moments/unseen", { cache: "no-store", signal: controller.signal });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: { unseen?: number } };
      // A slow answer that lands after a newer one has already been applied is discarded: the
      // count must only ever reflect the freshest reading the badge has taken.
      if (asked !== generation.current) return;
      const unseen = typeof body.data?.unseen === "number" && body.data.unseen >= 0 ? body.data.unseen : 0;
      answeredAt.current = performance.now();
      setCount(unseen);
    } catch {
      // Silence by design: a count is never worth an error surface.
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  // Per-navigation freshness: arriving on Moments marks the feed seen, so the badge must re-ask.
  useEffect(() => {
    void load();
  }, [load, pathname]);

  useEffect(() => {
    let timer: number | undefined;
    pollDelay.current ??= POLL_BASE_MS + Math.floor(Math.random() * (POLL_JITTER_MS + 1));
    const eligible = () => document.visibilityState === "visible" && navigator.onLine;
    const schedule = () => {
      window.clearInterval(timer);
      timer = eligible() ? window.setInterval(() => void load(), pollDelay.current) : undefined;
    };
    const resume = () => {
      schedule();
      window.clearTimeout(foregroundTimeout.current);
      if (!eligible()) return;
      const remaining = FOREGROUND_MIN_GAP_MS - (performance.now() - answeredAt.current);
      if (remaining <= 0) void load();
      else foregroundTimeout.current = window.setTimeout(() => void load(), remaining);
    };
    const suspend = () => {
      // Hidden or offline: stop the cadence rather than queue requests that cannot succeed.
      window.clearTimeout(foregroundTimeout.current);
      schedule();
    };
    schedule();
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", suspend);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(foregroundTimeout.current);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", suspend);
      document.removeEventListener("visibilitychange", resume);
      inFlight.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const api = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof api.setAppBadge !== "function" || typeof api.clearAppBadge !== "function") return;
    void (count > 0 ? api.setAppBadge(count) : api.clearAppBadge()).catch(() => undefined);
  }, [count]);

  if (count <= 0) return null;
  const label = `${count} new ${count === 1 ? "moment" : "moments"}`;
  if (placement === "tab") {
    return (
      <span
        aria-label={label}
        className="absolute -right-2.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white"
      >
        {count > 9 ? "9+" : count}
      </span>
    );
  }
  return (
    <span
      aria-label={label}
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-none text-white"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
