"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";

/**
 * A nav link that shows it was clicked.
 *
 * The loading boundary covers the content area, but the tabs live in the layout and stay mounted, so
 * without this the tab a parent just pressed looks identical to the one they left. That is the gap
 * that reads as "my click did nothing".
 *
 * Next 15 exposes useLinkStatus for exactly this. On 14 the equivalent is to hold the pathname the
 * user asked for and compare it with the pathname actually rendered: while they differ, that link is
 * pending. The transition is what keeps the click from blocking paint.
 */
const PendingHrefContext = createContext<{
  pendingPath: string | null;
  request: (path: string) => void;
}>({ pendingPath: null, request: () => {} });

export function NavPendingProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    // The requested route has rendered, so nothing is pending any more. Clearing on pathname rather
    // than on a timer means the indicator lasts exactly as long as the wait did.
    setPendingPath(null);
  }, [pathname]);

  return (
    <PendingHrefContext.Provider
      value={{
        pendingPath,
        request: (path: string) => startTransition(() => setPendingPath(path))
      }}
    >
      {children}
    </PendingHrefContext.Provider>
  );
}

export function NavLink({
  href,
  className,
  pendingClassName,
  active,
  children,
  onNavigate
}: {
  href: string;
  className?: string;
  pendingClassName?: string;
  active?: boolean;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  const { pendingPath, request } = useContext(PendingHrefContext);
  // pendingPath is only ever set from a NavLink href, so the two are the same string for the tab that
  // was clicked. Comparing them directly is enough; the rendered pathname is not involved here,
  // because clearing is driven by the pathname effect in the provider.
  const pending = pendingPath === href;

  return (
    <Link
      href={href}
      // Next 14 prefetches a dynamic route only to its nearest loading boundary, and only in a
      // production build. These are the handful of destinations a parent actually moves between, so
      // the cost is bounded and the common hops stop waiting on a cold render.
      prefetch
      aria-current={active ? "page" : undefined}
      aria-busy={pending ? true : undefined}
      className={cn(className, pending && (pendingClassName ?? "opacity-70"))}
      onClick={() => {
        request(href);
        onNavigate?.();
      }}
    >
      {children}
      {pending ? (
        // Colour and opacity alone would tell a sighted user only. This is the same fact, spoken.
        <span className="sr-only">Loading</span>
      ) : null}
    </Link>
  );
}
