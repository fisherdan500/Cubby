import Link from "next/link";
import { CalendarDays, ClipboardList, LineChart, Moon, PlusCircle, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { HeaderBabySelector } from "@/components/header-baby-selector";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { MobileHeaderMenu } from "@/components/mobile-header-menu";
import { BrandLockup } from "@/components/brand";
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

      <header className="sticky top-0 z-20 border-b border-primary/30 bg-card/95 backdrop-blur md:ml-64">
        <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2 md:min-h-20 md:px-8 md:py-0">
          <div className="min-w-0">
            <h1 className="truncate font-editorial text-base font-bold text-card-foreground md:text-xl">{title}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {babySelector ? (
              <HeaderBabySelector data={babySelector} />
            ) : (
              <span className="hidden rounded-full border border-border bg-muted px-4 py-2 text-sm font-bold text-card-foreground sm:block">{userName}</span>
            )}
            <MobileHeaderMenu userName={userName} />
          </div>
        </div>
      </header>

      <main className="app-shell-content px-3 pb-24 pt-3 md:ml-64 md:px-6 md:pt-5">
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
