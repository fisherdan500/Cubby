import Link from "next/link";
import { CalendarDays, ClipboardList, LineChart, Moon, PlusCircle, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { HeaderBabySelector } from "@/components/header-baby-selector";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { BrandLockup } from "@/components/brand";
import { BrowserOperationRecovery } from "@/components/browser-operation-recovery";
import { ActiveTimerBar } from "@/components/active-timer-bar";
import type { HeaderBabySelectorData } from "@/lib/baby-selector";

const primaryNav = [
  { href: "/app", label: "Log Entry", icon: PlusCircle },
  { href: "/app/history", label: "Full Log", icon: ClipboardList },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/app/reports", label: "Reports", icon: LineChart },
  { href: "/app/nursery", label: "Nursery", icon: Moon }
];

export function AppShell({
  children,
  title,
  userName,
  babySelector,
  parent
}: {
  children: React.ReactNode;
  title: string;
  userName: string;
  babySelector?: HeaderBabySelectorData | null;
  // Where a phone's back link at the top of the page goes, for pages reached from another page
  // (the settings sections) rather than from a bottom tab.
  parent?: { href: string; label: string };
}) {
  const selectedBabyId = babySelector?.selectedBabyId;

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-card/94 backdrop-blur md:flex md:flex-col">
        <Link href="/app" className="flex h-20 items-center gap-3 border-b border-border px-5">
          <BrandLockup size="sm" tagline="Family journal" priority />
        </Link>
        <nav className="flex-1 space-y-2 px-4 py-6">
          {primaryNav.map((item) => (
            <Link
              key={item.href}
              href={withBabyId(item.href, selectedBabyId)}
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-foreground/90 hover:bg-muted hover:text-foreground"
            >
              <item.icon className="h-5 w-5 text-primary" />
              {item.label}
            </Link>
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
          <Link
            href="/app/settings"
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-foreground/90 hover:bg-muted hover:text-foreground"
          >
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </Link>
          <SignOutButton />
        </div>
      </aside>

      {/* Desktop only. On a phone the header cost a pinned strip of every screen for a title the
          highlighted bottom tab already gives, so it is gone: the baby line and the settings back link
          below take its useful parts, scroll away with the content, and the menu lives behind More. */}
      <header className="sticky top-0 z-20 hidden border-b border-primary/30 bg-card/95 backdrop-blur md:ml-64 md:block">
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

      <main className="app-shell-content px-3 pb-[calc(6rem+var(--active-timer-bar,0rem))] pt-[max(0.75rem,env(safe-area-inset-top))] md:ml-64 md:px-6 md:pt-5">
        <div className="md:hidden">
          {babySelector ? <HeaderBabySelector data={babySelector} variant="line" /> : null}
          {parent ? (
            <nav aria-label="Breadcrumb" className="-mx-1 mb-2 flex min-h-11 min-w-0 items-center gap-1 text-sm">
              <Link href={parent.href} className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 font-bold text-primary hover:bg-muted">
                ← {parent.label}
              </Link>
              <span aria-hidden="true" className="text-muted-foreground">/</span>
              <h1 className="min-w-0 truncate font-black text-foreground">{title}</h1>
            </nav>
          ) : (
            // Every page still has one h1 for assistive technology, even where the phone shows no title.
            <h1 className="sr-only">{title}</h1>
          )}
        </div>
        <BrowserOperationRecovery />
        {children}
      </main>

      {/* Fetches its own running timers, so no page gains a database read for it. */}
      <ActiveTimerBar />
      <MobileBottomNav selectedBabyId={selectedBabyId} userName={userName} />
    </div>
  );
}

function withBabyId(href: string, babyId?: string) {
  if (!babyId || href.startsWith("/app/settings")) return href;
  return `${href}?babyId=${encodeURIComponent(babyId)}`;
}
