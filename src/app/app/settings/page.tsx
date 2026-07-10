import Link from "next/link";
import { Baby, Bell, DatabaseBackup, Download, KeyRound, Shield, UserRoundCog, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { hasPermission, type Permission } from "@/domain/roles";
import { getHouseholdContext } from "@/server/auth/context";
import { requireUserPage } from "@/server/auth/session";

const sections = [
  { href: "/app/settings/admin", label: "Admin", description: "Registration policy, household controls, and app behavior.", icon: Shield, permission: "household.manage" },
  { href: "/app/babies", label: "Babies", description: "Manage baby profiles, notes, and warning thresholds.", icon: Baby, permission: "baby.manage" },
  { href: "/app/settings/members", label: "Members and access", description: "Invite people, assign roles, and manage household access.", icon: Users, permission: "member.manage" },
  { href: "/app/settings/integrations", label: "Integrations", description: "API keys and webhook endpoints.", icon: KeyRound, permission: "integration.manage" },
  { href: "/app/settings/backups", label: "Backups", description: "JSON export, Sprout import, restore, and spreadsheet exports.", icon: DatabaseBackup, permission: "backup.manage" },
  { href: "/app/settings/export", label: "Export", description: "Download household activity data for review or sharing.", icon: Download, permission: "export.create" },
  { href: "/app/settings/notifications", label: "Notifications", description: "Browser subscriptions and preference records.", icon: Bell, permission: "notification.manage" },
  { href: "/app/settings/sessions", label: "Sessions", description: "Review and revoke signed-in devices.", icon: UserRoundCog, permission: "session.manage" }
] satisfies Array<{ href: string; label: string; description: string; icon: typeof Shield; permission: Permission }>;

export default async function SettingsPage({ searchParams }: { searchParams: { denied?: string } }) {
  const user = await requireUserPage();
  const ctx = await getHouseholdContext();
  const visibleSections = sections.filter((section) => hasPermission(ctx.role, section.permission));
  return (
    <AppShell title="Settings" userName={user.name}>
      {searchParams.denied === "1" ? (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm font-semibold text-danger">
          You do not have access to that setting.
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleSections.map((section) => (
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
