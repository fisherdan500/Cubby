import { AppShell } from "@/components/app-shell";
import { UnitPreferencesForm } from "@/components/settings/unit-preferences-form";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getUnitPreferenceSettings } from "@/server/services/unit-preferences";

export default async function UnitSettingsPage() {
  const { user } = await requireSettingsPage("household.manage");
  const settings = await getUnitPreferenceSettings();

  return (
    <AppShell title="Units" userName={user.name}>
      <Card className="mx-auto max-w-3xl">
        <h2 className="font-editorial text-xl font-bold">Household unit defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          New entries use these units. Existing activity keeps the unit it was saved with.
        </p>
        <UnitPreferencesForm {...settings} />
      </Card>
    </AppShell>
  );
}
