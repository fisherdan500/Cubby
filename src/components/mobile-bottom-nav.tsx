"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ClipboardList, LineChart, Menu, PlusCircle, Settings, Sparkles } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NavLink } from "@/components/nav-progress";
import { cn } from "@/lib/utils";
import { UnseenMomentsBadge } from "@/components/unseen-moments-badge";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

// Moments (the family feed) holds the tab the Full Log had: it is meant to replace it in time
// (DEC-PROD-421), and until then the Full Log is one tap further, behind More.
const mobileNav = [
  { href: "/app", label: "Log", icon: PlusCircle, requires: "activity.create" as const },
  { href: "/app/moments", label: "Moments", icon: Sparkles, requires: null },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays, requires: "activity.create" as const },
  { href: "/app/reports", label: "Reports", icon: LineChart, requires: "activity.create" as const }
];

const tab = "flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-xs font-semibold transition";
const tabOn = "bg-primary/14 text-primary ring-1 ring-primary/20";
const tabOff = "text-muted-foreground hover:bg-muted hover:text-foreground";
const sheetRow =
  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-bold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * On a phone there is no header: the bottom bar is the only chrome. The four places a parent moves
 * between are tabs; everything used occasionally - the Full Log, Settings, light/dark, signing out - sits
 * behind More, in a sheet that opens upward from the thumb rather than from the top corner.
 */
export function MobileBottomNav({
  selectedBabyId,
  userName,
  role
}: {
  selectedBabyId?: string;
  userName: string;
  role?: HouseholdRoleName;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moreActive = pathname.startsWith("/app/settings") || pathname === "/app/babies" || pathname === "/app/history";

  // A relative holds no activity.create, so the Log tab is absent rather than present and
  // refusing. Gated on the permission, not the role name, so a future non-logging role behaves
  // correctly without being added here.
  const tabs = role ? mobileNav.filter((item) => item.requires === null || hasPermission(role, item.requires)) : mobileNav;
  const canSeeFullLog = role ? hasPermission(role, "activity.create") : true;

  // Tabs plus the More button. Written as whole class names because Tailwind scans source text
  // and cannot see a class built by string interpolation.
  const gridColumns = tabs.length === 1 ? "grid-cols-2" : tabs.length === 2 ? "grid-cols-3" : tabs.length === 3 ? "grid-cols-4" : "grid-cols-5";

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
        // Tabbing out of the sheet closes it, so it never lingers over the page behind focus. Only focus
        // that lands somewhere else counts: Safari on iPhone focuses nothing on a tap, so a tap on an
        // item would otherwise close the sheet before the tap arrived. Taps outside close it on their own.
        const next = event.relatedTarget as Node | null;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
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
          {canSeeFullLog ? (
            <NavLink href={withBabyId("/app/history", selectedBabyId)} className={sheetRow} onNavigate={() => setOpen(false)}>
            <ClipboardList className="h-5 w-5 text-primary" />
            Full Log
          </NavLink>
          ) : null}
          <NavLink href="/app/settings" className={sheetRow} onNavigate={() => setOpen(false)}>
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </NavLink>
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-sm font-bold">
            <span>Appearance</span>
            <ThemeToggle />
          </div>
          <SignOutButton />
        </div>
      ) : null}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/96 px-2 py-2 shadow-[0_-8px_24px_hsl(var(--shadow)/0.08)] backdrop-blur">
        <div className={cn("grid gap-1", gridColumns)}>
          {tabs.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <NavLink
                key={item.href}
                href={withBabyId(item.href, selectedBabyId)}
                className={cn(tab, active ? tabOn : tabOff)}
                pendingClassName="bg-primary/14 text-primary ring-1 ring-primary/20"
                active={active}
              >
                <span className="relative">
                  <item.icon className="h-5 w-5" />
                  {item.href === "/app/moments" ? <UnseenMomentsBadge placement="tab" /> : null}
                </span>
                {item.label}
              </NavLink>
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
