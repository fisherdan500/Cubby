import Link from "next/link";
import { Baby, Clock, Home, Menu, Moon, Settings, Users } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";

const nav = [
  { href: "/app", label: "Today", icon: Home },
  { href: "/app/history", label: "History", icon: Clock },
  { href: "/app/nursery", label: "Nursery", icon: Moon },
  { href: "/app/babies", label: "Babies", icon: Baby },
  { href: "/app/settings/members", label: "Members", icon: Users },
  { href: "/app/settings/sessions", label: "Settings", icon: Settings }
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/92 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/app" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Menu className="h-5 w-5" />
            </div>
            <div>
              <p className="text-base font-bold">Cubby</p>
              <p className="text-xs text-muted-foreground">Track the little things.</p>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:block">{userName}</span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-5">
        <h1 className="mb-4 text-2xl font-bold">{title}</h1>
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/96 px-2 py-2 shadow-soft backdrop-blur md:hidden">
        <div className="grid grid-cols-6 gap-1">
          {nav.map((item) => (
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

      <aside className="fixed left-0 top-20 hidden w-56 px-4 md:block">
        <div className="space-y-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </div>
      </aside>
    </div>
  );
}
