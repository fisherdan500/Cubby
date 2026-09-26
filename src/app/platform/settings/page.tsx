import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandLockup } from "@/components/brand";
import { PlatformHealthPanel } from "@/components/settings/platform-health-panel";
import { PlatformTestEmail } from "@/components/settings/platform-test-email";
import { RegistrationSettingsForm } from "@/components/settings/registration-settings-form";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card } from "@/components/ui/card";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";
import { getPlatformRegistrationSettings } from "@/server/services/platform-authority";
import { getPlatformHealth } from "@/server/services/platform-health";

export default async function PlatformSettingsPage() {
  const user = await requireUserPage();
  let settings;
  let health;
  const now = new Date();
  try {
    settings = await getPlatformRegistrationSettings();
    health = await getPlatformHealth(now);
  } catch (error) {
    if (error instanceof Error && error.message === "forbidden") {
      notFound();
    }
    throw error;
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/app" aria-label="Back to Cubby">
            <BrandLockup orientation="horizontal" size="sm" priority />
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user.name}</span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-primary">Platform administration</p>
          <h1 className="font-editorial text-3xl font-bold">Registration policy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deployment-wide controls are separate from every household role and settings surface.
          </p>
        </div>
        <Card>
          <RegistrationSettingsForm
            householdCreationMode={settings.householdCreationMode}
            allowPublicRegistration={settings.allowPublicRegistration}
          />
        </Card>
        <Card>
          <PlatformHealthPanel health={health} now={now} timeZone={env.APP_TIMEZONE} />
        </Card>
        <Card>
          <PlatformTestEmail />
        </Card>
      </div>
    </main>
  );
}
