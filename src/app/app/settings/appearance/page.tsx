import { AppShell } from "@/components/app-shell";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getHouseholdAppearance } from "@/server/services/appearance";

export default async function AppearanceSettingsPage() {
  const { user } = await requireSettingsPage("household.manage");
  const appearance = await getHouseholdAppearance();

  return (
    <AppShell title="Appearance" userName={user.name}>
      <Card className="max-w-2xl">
        <p className="font-editorial text-2xl font-semibold">Family accent</p>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          Choose the household color used for navigation, focus states, and selected controls.
        </p>
        <AppearanceForm initialTheme={appearance.accentTheme} />
      </Card>
    </AppShell>
  );
}
