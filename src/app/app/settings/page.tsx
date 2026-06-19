import Link from "next/link";
import { Baby, Bell, DatabaseBackup, KeyRound, Shield, UserRoundCog, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";

const sections = [
  { href: "/app/settings/admin", label: "Admin", description: "Registration policy, household controls, and app behavior.", icon: Shield },
  { href: "/app/babies", label: "Babies", description: "Manage baby profiles, notes, and warning thresholds.", icon: Baby },
  { href: "/app/settings/members", label: "Members and invites", description: "Invite caretakers and review pending invites.", icon: Users },
  { href: "/app/settings/integrations", label: "Integrations", description: "API keys and webhook endpoints.", icon: KeyRound },
  { href: "/app/settings/backups", label: "Backups", description: "JSON export, Sprout import, restore, and spreadsheet exports.", icon: DatabaseBackup },
  { href: "/app/settings/notifications", label: "Notifications", description: "Browser subscriptions and preference records.", icon: Bell },
  { href: "/app/settings/sessions", label: "Sessions", description: "Review and revoke signed-in devices.", icon: UserRoundCog }
];

export default async function SettingsPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Settings" userName={user.name}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sections.map((section) => (
          <Link key={section.href} href={section.href}>
            <Card className="h-full transition hover:bg-muted">
              <section.icon className="mb-4 h-6 w-6 text-primary" />
              <h2 className="text-lg font-black">{section.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </AppShell>
  );
}
