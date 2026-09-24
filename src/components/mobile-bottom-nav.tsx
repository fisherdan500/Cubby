"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ClipboardList, LineChart, Menu, PlusCircle, Settings } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const mobileNav = [
  { href: "/app", label: "Log", icon: PlusCircle },
  { href: "/app/history", label: "Full Log", icon: ClipboardList },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/app/reports", label: "Reports", icon: LineChart }
];

const tab = "flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-xs font-semibold transition";
const tabOn = "bg-primary/14 text-primary ring-1 ring-primary/20";
const tabOff = "text-muted-foreground hover:bg-muted hover:text-foreground";
const sheetRow =
  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-bold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * On a phone there is no header: the bottom bar is the only chrome. The four places a parent moves
 * between are tabs; everything used occasionally - Settings, light/dark, signing out - sits
 * behind More, in a sheet that opens upward from the thumb rather than from the top corner.
 */
export function MobileBottomNav({ selectedBabyId, userName }: { selectedBabyId?: string; userName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moreActive = pathname.startsWith("/app/settings") || pathname === "/app/babies";

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    // Keyboard and screen-reader users land on the first choice instead of staying on the trigger with
    // the sheet opened somewhere above them.
    panelRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();

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
    <div
      ref={rootRef}
      className="md:hidden print:hidden"
      onBlur={(event) => {
        // Tabbing out of the sheet closes it, so it never lingers over the page behind focus.
        if (open && !rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {open ? (
        <div
          ref={panelRef}
          id="mobile-more-panel"
          role="group"
          aria-label="More"
          className="fixed inset-x-3 bottom-[4.75rem] z-40 space-y-0.5 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-xl"
        >
          <p className="truncate px-3 py-2 text-xs font-bold text-muted-foreground">Signed in as {userName}</p>
          <Link href="/app/settings" className={sheetRow} onClick={() => setOpen(false)}>
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

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/96 px-2 py-2 shadow-[0_-8px_24px_hsl(var(--shadow)/0.08)] backdrop-blur">
        <div className="grid grid-cols-5 gap-1">
          {mobileNav.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={withBabyId(item.href, selectedBabyId)}
                className={cn(tab, active ? tabOn : tabOff)}
                aria-current={active ? "page" : undefined}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
          <button
            ref={triggerRef}
            type="button"
            className={cn(tab, moreActive || open ? tabOn : tabOff)}
            aria-expanded={open}
            aria-controls="mobile-more-panel"
            onClick={() => setOpen((current) => !current)}
          >
            <Menu className="h-5 w-5" />
            More
          </button>
        </div>
      </nav>
    </div>
  );
}

function isActivePath(pathname: string, href: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function withBabyId(href: string, babyId?: string) {
  if (!babyId) return href;
  return `${href}?babyId=${encodeURIComponent(babyId)}`;
}
