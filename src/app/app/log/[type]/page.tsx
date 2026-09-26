import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityForm } from "@/components/forms/activity-form";
import { ActivityFormHeader } from "@/components/forms/activity-form-header";
import { Card } from "@/components/ui/card";
import { activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { resolveSelectedBaby } from "@/lib/baby-selector";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";
import { getLastFeeding } from "@/server/services/activities";
import { getHouseholdHome } from "@/server/services/households";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

export default async function LogActivityPage({
  params,
  searchParams
}: {
  params: { type: string };
  searchParams: { babyId?: string; date?: string; returnTo?: string };
}) {
  const type = params.type as ActivityTypeName;
  if (!activityTypes.includes(type)) notFound();
  const user = await requireUserPage();
  const home = await getHouseholdHome();
  if (!home) redirect("/onboarding");
  const unitSettings = await getActivityUnitPreferences();
  const babies = home.household.babies.map((baby) => ({
    id: baby.id,
    name: baby.name
  }));
  const selectedBaby = resolveSelectedBaby(babies, searchParams.babyId);
  // A new feed starts as the last one was, so the same bottle is not typed in every time.
  const lastFeeding = type === "feeding" ? await getLastFeeding(selectedBaby?.id) : null;

  return (
    <AppShell title={`Log ${activityLabels[type]}`} userName={user.name} timerBabyId={selectedBaby?.id}>
      {/* Bottom padding keeps the last field clear of the form's fixed Cancel / Log bar. */}
      <div className="pb-20">
        <Card className="mx-auto max-w-lg space-y-4">
          <ActivityFormHeader type={type} />
          {babies.length ? (
            <ActivityForm
              babies={babies}
              type={type}
              selectedBabyId={selectedBaby?.id}
              returnDate={searchParams.date}
              returnTo={searchParams.returnTo}
              appTimeZone={env.APP_TIMEZONE}
              unitPreferences={unitSettings.preferences}
              medicineNames={unitSettings.medicineNames}
              supplementNames={unitSettings.supplementNames}
              lastFeeding={lastFeeding}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No active babies.</p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
