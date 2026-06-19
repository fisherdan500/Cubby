import Link from "next/link";
import { Baby, CalendarDays, ClipboardList, LineChart, Moon, PlusCircle, Settings, Users } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";

const nav = [
  { href: "/app", label: "Log Entry", icon: PlusCircle },
  { href: "/app/history", label: "Full Log", icon: ClipboardList },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/app/reports", label: "Reports", icon: LineChart },
  { href: "/app/babies", label: "Babies", icon: Baby },
  { href: "/app/settings/members", label: "Members", icon: Users },
  { href: "/app/nursery", label: "Nursery", icon: Moon },
  { href: "/app/settings", label: "Settings", icon: Settings }
];

export function AppShell({
  children,
  title,
  userName
}: {
  children: React.ReactNode;
  title: string;
  userName: string;
}) {
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
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-foreground/90 hover:bg-muted hover:text-foreground"
            >
              <item.icon className="h-5 w-5 text-primary" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border p-4">
          <div className="mb-3 flex items-center gap-3 rounded-md bg-muted p-3">
            <Moon className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-bold">Dark</p>
              <p className="text-xs text-muted-foreground">Switch to system</p>
            </div>
            <ThemeToggle />
          </div>
          <SignOutButton />
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-border bg-primary/80 backdrop-blur md:ml-64">
        <div className="flex min-h-20 items-center justify-between gap-3 px-4 md:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-normal text-primary-foreground/75">Cubby</p>
            <h1 className="text-base font-black text-primary-foreground sm:text-lg">{title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full bg-blue-500 px-4 py-2 text-sm font-bold text-white sm:block">{userName}</span>
            <div className="md:hidden">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 pb-24 pt-5 md:ml-64 md:px-6">
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/96 px-2 py-2 shadow-soft backdrop-blur md:hidden">
        <div className="grid grid-cols-5 gap-1">
          {nav.slice(0, 5).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
