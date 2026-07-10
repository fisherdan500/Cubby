"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, ClipboardList, LineChart, Moon, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const mobileNav = [
  { href: "/app", label: "Log", icon: PlusCircle },
  { href: "/app/history", label: "Full Log", icon: ClipboardList },
  { href: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/app/reports", label: "Reports", icon: LineChart },
  { href: "/app/nursery", label: "Nursery", icon: Moon }
];

export function MobileBottomNav({ selectedBabyId }: { selectedBabyId?: string }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/96 px-2 py-2 shadow-[0_-8px_24px_hsl(var(--shadow)/0.08)] backdrop-blur md:hidden">
      <div className="grid grid-cols-5 gap-1">
        {mobileNav.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={withBabyId(item.href, selectedBabyId)}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-black transition",
                active
                  ? "bg-primary/14 text-primary ring-1 ring-primary/20"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
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
