import Link from "next/link";
import { Baby, Bell, DatabaseBackup, Download, KeyRound, LockKeyhole, LogOut, Palette, Ruler, Shield, SunMoon, UserRoundCog, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { hasPermission, type Permission } from "@/domain/roles";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import { requireUserPage } from "@/server/auth/session";
import { isPlatformOwner } from "@/server/services/platform-authority";
import { getAppRegistrationPolicy } from "@/server/services/registration";

const sections = [
  { href: "/app/settings/appearance", label: "Appearance", description: "Choose the household accent and visual character.", icon: Palette, permission: "household.manage" },
  { href: "/app/settings/units", label: "Units", description: "Choose defaults for measurements, medicine, and supplements.", icon: Ruler, permission: "household.manage" },

  { href: "/app/babies", label: "Babies", description: "Manage baby profiles, notes, and warning thresholds.", icon: Baby, permission: "baby.manage" },
  { href: "/app/settings/members", label: "Members and access", description: "Invite people, assign roles, and manage household access.", icon: Users, permission: "member.manage" },
  { href: "/app/settings/integrations", label: "Integrations", description: "API keys and webhook endpoints.", icon: KeyRound, permission: "integration.manage" },
  { href: "/app/settings/backups", label: "Backups", description: "JSON export, Sprout import, restore, and spreadsheet exports.", icon: DatabaseBackup, permission: "backup.manage" },
  { href: "/app/settings/export", label: "Export", description: "Download household activity data for review or sharing.", icon: Download, permission: "export.create" },
  { href: "/app/settings/notifications", label: "Notifications", description: "Browser subscriptions and preference records.", icon: Bell, permission: "notification.manage" },
  { href: "/app/settings/sessions", label: "Sessions", description: "Review and revoke browsers signed into your account.", icon: UserRoundCog, permission: "session.manage" }
] satisfies Array<{ href: string; label: string; description: string; icon: typeof Shield; permission: Permission }>;

// These belong to the person rather than to a household role, so every signed-in member sees them.
const accountSections = [
  { href: "/account/security", label: "Account security", description: "Change your password or email, set up recovery codes, and see your security history.", icon: LockKeyhole },
  { href: "/account/appearance", label: "Personal appearance", description: "Your own light, dark or system theme, kept across your devices.", icon: SunMoon }
] satisfies Array<{ href: string; label: string; description: string; icon: typeof Shield }>;

export default async function SettingsPage({ searchParams }: { searchParams: { denied?: string } }) {
  const user = await requireUserPage();
  const ctx = await getEffectiveHouseholdContext();
  const [platformOwner, policy] = await Promise.all([isPlatformOwner(user.id), getAppRegistrationPolicy()]);
  const visibleSections = sections.filter((section) => hasPermission(ctx.role, section.permission));
  return (
    <AppShell title="Settings" userName={user.name}>
      {searchParams.denied === "1" ? (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm font-semibold text-danger">
          You do not have access to that setting.
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...accountSections, ...visibleSections].map((section) => (
          <Link key={section.href} href={section.href} prefetch={false}>
            <Card className="h-full transition hover:bg-muted">
              <section.icon className="mb-4 h-6 w-6 text-primary" />
              <h2 className="font-editorial text-lg font-bold">{section.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
            </Card>
          </Link>
        ))}
        <Link href="/app/settings/leave" prefetch={false}>
          <Card className="h-full transition hover:bg-muted">
            <LogOut className="mb-4 h-6 w-6 text-danger" />
            <h2 className="font-editorial text-lg font-bold">Leave household</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Review warnings and close your current non-owner membership.
            </p>
          </Card>
        </Link>
        {!policy.platformOwnerBound ? (
          <Link href="/setup" prefetch={false}>
            <Card className="h-full transition hover:bg-muted">
              <Shield className="mb-4 h-6 w-6 text-primary" />
              <h2 className="font-editorial text-lg font-bold">Finish Cubby setup</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                No one is platform owner yet. Claim it with the one-time code from the server log.
              </p>
            </Card>
          </Link>
        ) : null}
        {platformOwner ? (
          <Link href="/platform/settings" prefetch={false}>
            <Card className="h-full transition hover:bg-muted">
              <Shield className="mb-4 h-6 w-6 text-primary" />
              <h2 className="font-editorial text-lg font-bold">Platform administration</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage deployment-wide account and household-creation policy outside household roles.
              </p>
            </Card>
          </Link>
        ) : null}
      </div>
    </AppShell>
  );
}
