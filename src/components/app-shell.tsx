import Link from "next/link";
import { CalendarDays, ClipboardList, LineChart, Moon, PlusCircle, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { HeaderBabySelector } from "@/components/header-baby-selector";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
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
  babySelector
}: {
  children: React.ReactNode;
  title: string;
  userName: string;
  babySelector?: HeaderBabySelectorData | null;
}) {
  const selectedBabyId = babySelector?.selectedBabyId;

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-slate-700/60 backdrop-blur md:flex md:flex-col">
        <Link href="/app" className="flex h-20 items-center gap-3 border-b border-border px-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-lg font-black text-primary-foreground">
            C
          </div>
          <div>
            <p className="text-xl font-black text-primary">Cubby</p>
            <p className="text-sm font-semibold text-foreground">Family tracker</p>
          </div>
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
          <div className="flex items-center gap-3 rounded-md bg-muted p-3">
            <Moon className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-bold">Dark</p>
              <p className="text-xs text-muted-foreground">Switch to system</p>
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

      <header className="sticky top-0 z-20 border-b border-border bg-primary/90 backdrop-blur md:ml-64">
        <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2 md:min-h-20 md:px-8 md:py-0">
          <div className="min-w-0">
            <p className="hidden text-[10px] font-bold uppercase tracking-normal text-primary-foreground/75 sm:block md:text-xs">Cubby</p>
            <h1 className="truncate text-sm font-black text-primary-foreground sm:text-base md:text-lg">{title}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {babySelector ? (
              <HeaderBabySelector data={babySelector} />
            ) : (
              <span className="hidden rounded-full bg-blue-500 px-4 py-2 text-sm font-bold text-white sm:block">{userName}</span>
            )}
            <div className="flex items-center gap-1 md:hidden">
              <ThemeToggle />
              <Link
                href="/app/settings"
                className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-primary-foreground hover:bg-primary-foreground/15"
                aria-label="Settings"
              >
                <Settings className="h-5 w-5" />
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="px-3 pb-24 pt-3 md:ml-64 md:px-6 md:pt-5">
        {children}
      </main>

      <MobileBottomNav selectedBabyId={selectedBabyId} />
    </div>
  );
}

function withBabyId(href: string, babyId?: string) {
  if (!babyId || href.startsWith("/app/settings")) return href;
  return `${href}?babyId=${encodeURIComponent(babyId)}`;
}
