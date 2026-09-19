import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityForm } from "@/components/forms/activity-form";
import { ActivityFormHeader } from "@/components/forms/activity-form-header";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { activityDetailHref, activityFallbackHref, safeActivityReturnTo } from "@/lib/activity-navigation";
import { activityUnavailableOrThrow } from "@/lib/activity-page-error";
import { activityEditBabies } from "@/lib/baby-selector";
import { env } from "@/lib/env";
import { activityEditInitial } from "@/lib/activity-edit-initial";
import { requireUserPage } from "@/server/auth/session";
import { getActivityForEdit } from "@/server/services/activities";
import { getHouseholdHome } from "@/server/services/households";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

export default async function EditActivityPage({ params, searchParams }: { params: { id: string }; searchParams: { returnTo?: string | string[] } }) {
  const user = await requireUserPage();
  const home = await getHouseholdHome({ includeInactive: true });
  if (!home) redirect("/onboarding");
  const [activity, unitSettings] = await Promise.all([
    getActivityForEdit(params.id).catch(activityUnavailableOrThrow),
    getActivityUnitPreferences()
  ]);
  if (!activity) notFound();
  const type = activity.type as ActivityTypeName;
  const babies = activityEditBabies(home.household.babies, activity.babyId);
  const initial = activityEditInitial(activity, env.APP_TIMEZONE);
  const sourceReturnTo =
    safeActivityReturnTo(searchParams.returnTo) ??
    activityFallbackHref({ babyId: activity.babyId, occurredAt: activity.occurredAt, timeZone: env.APP_TIMEZONE });
  const detailHref = activityDetailHref(activity.id, sourceReturnTo);

  return (
    <AppShell title={`Edit ${activityLabels[type]}`} userName={user.name}>
      {/* Bottom padding keeps the last field clear of the form's fixed Cancel / Save bar. */}
      <div className="mx-auto max-w-lg space-y-4 pb-20">
        <Card className="space-y-4">
          <ActivityFormHeader type={type} />
          <ActivityForm
            babies={babies}
            type={type}
            activityId={activity.id}
            initial={initial}
            returnTo={detailHref}
            successTo={detailHref}
            allowActivityDestination
            appTimeZone={env.APP_TIMEZONE}
            unitPreferences={unitSettings.preferences}
            medicineNames={unitSettings.medicineNames}
            supplementNames={unitSettings.supplementNames}
          />
        </Card>
      </div>
    </AppShell>
  );
}
