import { AppShell } from "@/components/app-shell";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { PersonalAppearanceForm } from "@/components/personal-appearance-form";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getHouseholdAppearance } from "@/server/services/appearance";
import { getAccountAppearance } from "@/server/services/account-appearance";

export default async function AppearanceSettingsPage() {
  const { user } = await requireSettingsPage("household.manage");
  const [appearance, personal] = await Promise.all([getHouseholdAppearance(), getAccountAppearance()]);

  return (
    <AppShell title="Appearance" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <div className="max-w-2xl space-y-4">
        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Personal account</p>
          <p className="font-editorial text-2xl font-semibold">Personal appearance</p>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">Shared across your authorized devices and independent of household data.</p>
          <PersonalAppearanceForm initialMode={personal.appearanceMode} initialRevision={personal.appearanceRevision} />
        </Card>
        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Selected household</p>
          <p className="font-editorial text-2xl font-semibold">Family accent</p>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">
            Choose the selected household color used for navigation, focus states, and selected controls.
          </p>
          <AppearanceForm initialTheme={appearance.accentTheme} />
        </Card>
      </div>
    </AppShell>
  );
}
