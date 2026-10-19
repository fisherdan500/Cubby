"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * The red count over the Moments tab: how many moments arrived since this member last looked.
 *
 * The badge asks for its own count, the way the timer bar asks for its own timers: the shell is a
 * synchronous server component rendered by every signed-in page, and making all of chrome await a
 * count would put a database read on twenty pages for one dot. Fetched on mount and on every route
 * change (per-navigation freshness), silently zero on any failure - chrome never takes a page down.
 *
 * Rendered only when there is something to say - zero means no badge, not a grey zero - and capped
 * at 9+ so a week away does not become a four-digit scare. The aria-label carries the real number.
 * Navigating to Moments marks the feed seen server-side, and the route-change re-fetch then clears
 * the badge without a reload.
 *
 * Also mirrors the count onto the installed app's icon where the platform supports it (Badging
 * API), clearing at zero so a read feed stops shouting.
 */
export function UnseenMomentsBadge({ placement }: { placement: "sidebar" | "tab" }) {
  const pathname = usePathname() ?? "";
  const [count, setCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/moments/unseen", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const body = (await response.json()) as { data?: { unseen?: number } };
        const unseen = typeof body.data?.unseen === "number" && body.data.unseen >= 0 ? body.data.unseen : 0;
        setCount(unseen);
      } catch {
        // Silence by design: a count is never worth an error surface.
      }
    }
    void load();
    return () => controller.abort();
  }, [pathname]);

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
        className="absolute -right-2.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
      >
        {count > 9 ? "9+" : count}
      </span>
    );
  }
  return (
    <span
      aria-label={label}
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-destructive-foreground"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
