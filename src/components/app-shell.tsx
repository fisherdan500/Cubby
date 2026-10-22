import Link from "next/link";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { PageFreshness } from "@/components/app-freshness";
import { CalendarDays, ClipboardList, LineChart, Moon, PlusCircle, Settings, Sparkles } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { HeaderBabySelector } from "@/components/header-baby-selector";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { BrandLockup } from "@/components/brand";
import { BrowserOperationRecovery } from "@/components/browser-operation-recovery";
import { ActiveTimerBar } from "@/components/active-timer-bar";
import { NavLink, NavPendingProvider } from "@/components/nav-progress";
import { SavedEntryUndo } from "@/components/saved-entry-undo";
import { UnseenMomentsBadge } from "@/components/unseen-moments-badge";
import type { HeaderBabySelectorData } from "@/lib/baby-selector";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

// Each destination names the permission it needs, so a member is never shown a screen that will
// refuse them. A relative (read_only) holds activity.read but not activity.create, so Log Entry is
// absent from their navigation entirely rather than present and broken.
//
// "requires: null" means every member sees it.
const primaryNav = [
  { href: "/app", label: "Log Entry", icon: PlusCircle, requires: "activity.create" as const },
  { href: "/app/moments", label: "Moments", icon: Sparkles, requires: null },
  { href: "/app/history", label: "Full Log", icon: ClipboardList, requires: "activity.create" as const },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays, requires: "activity.create" as const },
  { href: "/app/reports", label: "Reports", icon: LineChart, requires: "activity.create" as const }
];

/**
 * The navigation a given role should see.
 *
 * Gated on activity.create rather than on the role name: a future role that cannot log entries gets
 * the same treatment without anyone remembering to add it here. The User's decision (2026-10-22) is
 * that a relative sees Moments only -- photos and milestones, not feeding and sleep statistics.
 */
export function navForRole(role: HouseholdRoleName | undefined) {
  if (!role) return primaryNav;
  return primaryNav.filter((item) => item.requires === null || hasPermission(role, item.requires));
}

export function AppShell({
  children,
  title,
  userName,
  babySelector,
  timerBabyId,
  timerActivityType,
  showAllTimers,
  parent,
  role
}: {
  children: React.ReactNode;
  title: string;
  userName: string;
  babySelector?: HeaderBabySelectorData | null;
  timerBabyId?: string;
  // Set on one activity's own screens (logging, viewing, editing it): the running-timer bar appears
  // there for a timer of that activity only.
  timerActivityType?: string;
  // Set on the Log screen alone: the bar appears there with every running timer. No other screen
  // sets either, so Moments, Calendar, Reports and Settings never show the bar.
  showAllTimers?: boolean;
  // Where a phone's back link at the top of the page goes, for pages reached from another page
  // (the settings sections) rather than from a bottom tab.
  parent?: { href: string; label: string };
  // The viewer's role in the household on screen. Omitted by screens that are not household-scoped
  // (onboarding, account recovery), where the full navigation is correct.
  role?: HouseholdRoleName;
}) {
  const selectedBabyId = babySelector?.selectedBabyId;
  const navItems = navForRole(role);
  // A relative has no Log Entry screen, so the brand link must not lead there.
  const homeHref = navItems[0]?.href ?? "/app/moments";

  return (
    <NavPendingProvider>
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-card/94 backdrop-blur md:flex md:flex-col print:hidden">
        <Link href={homeHref} className="flex h-20 items-center gap-3 border-b border-border px-5">
          <BrandLockup size="sm" tagline="Family journal" priority />
        </Link>
        <nav className="flex-1 space-y-2 px-4 py-6">
          {navItems.map((item) => (
            <NavLink
              key={item.href}
              href={withBabyId(item.href, selectedBabyId)}
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-foreground/90 hover:bg-muted hover:text-foreground"
              pendingClassName="bg-muted text-foreground"
            >
              <item.icon className="h-5 w-5 text-primary" />
              {item.label}
              {item.href === "/app/moments" ? <UnseenMomentsBadge placement="sidebar" /> : null}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-3 border-t border-border p-4">
          <div className="flex items-center gap-3 rounded-md bg-surface p-3">
            <Moon className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-bold">Appearance</p>
              <p className="text-xs text-muted-foreground">Light or dark</p>
            </div>
            <ThemeToggle />
          </div>
          <NavLink
            href="/app/settings"
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-foreground/90 hover:bg-muted hover:text-foreground"
            pendingClassName="bg-muted text-foreground"
          >
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </NavLink>
          <SignOutButton />
        </div>
      </aside>

      {/* Desktop only. On a phone the header cost a pinned strip of every screen for a title the
          highlighted bottom tab already gives, so it is gone: the baby line and the settings back link
          below take its useful parts, scroll away with the content, and the menu lives behind More. */}
      <header className="sticky top-0 z-20 hidden border-b border-primary/30 bg-card/95 backdrop-blur md:ml-64 md:block print:hidden">
        <div className="flex min-h-20 items-center justify-between gap-2 px-8">
          <div className="min-w-0">
            <h1 className="truncate font-editorial text-xl font-bold text-card-foreground">{title}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {babySelector ? (
              <HeaderBabySelector data={babySelector} />
            ) : (
              <span className="rounded-full border border-border bg-muted px-4 py-2 text-sm font-bold text-card-foreground">{userName}</span>
            )}
          </div>
        </div>
      </header>

      {/* On paper only the page's own content is printed: no navigation, header or pinned bars. */}
      <main className="app-shell-content px-3 pb-[calc(6rem+var(--active-timer-bar,0rem))] pt-[max(0.75rem,env(safe-area-inset-top))] md:ml-64 md:px-6 md:pt-5 print:m-0 print:p-0">
        <div className="md:hidden print:hidden">
          {babySelector ? <HeaderBabySelector data={babySelector} variant="line" /> : null}
          {parent ? (
            <nav aria-label="Breadcrumb" className="-mx-1 mb-2 flex min-h-11 min-w-0 items-center gap-1 text-sm">
              <Link href={parent.href} className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 font-bold text-primary hover:bg-muted">
                ← {parent.label}
              </Link>
              <span aria-hidden="true" className="text-muted-foreground">/</span>
              <h1 className="min-w-0 truncate font-semibold text-foreground">{title}</h1>
            </nav>
          ) : (
            // Every page still has one h1 for assistive technology, even where the phone shows no title.
            <h1 className="sr-only">{title}</h1>
          )}
        </div>
        <BrowserOperationRecovery />
        <PageFreshness token={randomUUID()} confirmedAt={new Date().toISOString()} timeZone={env.APP_TIMEZONE} />
        {children}
      </main>

      {/* On the Log screen, with every running timer, and on an activity's own screen, for a timer of
          that activity - nowhere else. Fetches its own running timers, so no page gains a database
          read for it. */}
      {showAllTimers || timerActivityType ? (
        <ActiveTimerBar selectedBabyId={timerBabyId ?? selectedBabyId} activityType={timerActivityType} />
      ) : null}
      <SavedEntryUndo />
      <MobileBottomNav selectedBabyId={selectedBabyId} userName={userName}  role={role}/>
    </div>
    </NavPendingProvider>
  );
}

function withBabyId(href: string, babyId?: string) {
  if (!babyId || href.startsWith("/app/settings")) return href;
  return `${href}?babyId=${encodeURIComponent(babyId)}`;
}
