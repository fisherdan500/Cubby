"use client";

import Link from "next/link";
import { Menu, Settings } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function MobileHeaderMenu({ userName }: { userName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settingsActive = pathname.startsWith("/app/settings") || pathname === "/app/babies";

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-black text-card-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          settingsActive && "bg-muted"
        )}
        aria-expanded={open}
        aria-controls="mobile-header-menu-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>

      {open ? (
        <div
          id="mobile-header-menu-panel"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-xl"
          aria-label="Account and settings"
        >
          <p className="truncate px-3 py-2 text-xs font-bold text-muted-foreground">Signed in as {userName}</p>
          <Link
            href="/app/settings"
            className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-bold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen(false)}
          >
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </Link>
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-sm font-bold">
            <span>Appearance</span>
            <ThemeToggle />
          </div>
          <SignOutButton />
        </div>
      ) : null}
    </div>
  );
}
