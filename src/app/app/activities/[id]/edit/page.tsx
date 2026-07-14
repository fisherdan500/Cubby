import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityForm } from "@/components/forms/activity-form";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { activityDetailHref, activityFallbackHref, safeActivityReturnTo } from "@/lib/activity-navigation";
import { activityUnavailableOrThrow } from "@/lib/activity-page-error";
import { env } from "@/lib/env";
import { dateTimeInputValue } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { getActivityForEdit } from "@/server/services/activities";
import { getHouseholdHome } from "@/server/services/households";
import { getActivityUnitPreferences } from "@/server/services/unit-preferences";

export default async function EditActivityPage({ params, searchParams }: { params: { id: string }; searchParams: { returnTo?: string | string[] } }) {
  const user = await requireUserPage();
  const home = await getHouseholdHome(user.id);
  if (!home) redirect("/onboarding");
  const [activity, unitSettings] = await Promise.all([
    getActivityForEdit(params.id).catch(activityUnavailableOrThrow),
    getActivityUnitPreferences()
  ]);
  if (!activity) notFound();
  const type = activity.type as ActivityTypeName;
  const babies = home.household.babies.map((baby) => ({ id: baby.id, name: baby.name }));
  const initial = serializeActivity(activity);
  const sourceReturnTo =
    safeActivityReturnTo(searchParams.returnTo) ??
    activityFallbackHref({ babyId: activity.babyId, occurredAt: activity.occurredAt, timeZone: env.APP_TIMEZONE });
  const detailHref = activityDetailHref(activity.id, sourceReturnTo);

  return (
    <AppShell title={`Edit ${activityLabels[type]}`} userName={user.name}>
      <div className="mx-auto max-w-2xl space-y-4">
        <Card>
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

function localValue(date?: Date | null) {
  if (!date) return "";
  return dateTimeInputValue(date, env.APP_TIMEZONE);
}

function serializeActivity(activity: Awaited<ReturnType<typeof getActivityForEdit>>) {
  return {
    id: activity.id,
    updatedAt: activity.updatedAt.toISOString(),
    babyId: activity.babyId,
    occurredAt: localValue(activity.occurredAt),
    startedAt: localValue(activity.startedAt),
    endedAt: localValue(activity.endedAt),
    notes: activity.notes,
    mode: activity.feeding?.mode,
    amount: activity.feeding?.amount?.toString() ?? activity.pumping?.amount?.toString() ?? activity.milkInventory?.amount?.toString(),
    unit: activity.feeding?.unit ?? activity.pumping?.unit ?? activity.medicine?.unit ?? activity.supplement?.unit ?? activity.milkInventory?.unit,
    side: activity.feeding?.side,
    bottleType: activity.feeding?.bottleType,
    food: activity.feeding?.food,
    leftSeconds: activity.feeding?.leftSeconds,
    rightSeconds: activity.feeding?.rightSeconds,
    kind: activity.diaper?.kind,
    color: activity.diaper?.color,
    consistency: activity.diaper?.consistency,
    rashConcern: activity.diaper?.rashConcern,
    condition: activity.diaper?.condition,
    blowout: activity.diaper?.blowout,
    creamApplied: activity.diaper?.creamApplied,
    sleepType: activity.sleep?.sleepType,
    location: activity.sleep?.location ?? activity.play?.location,
    quality: activity.sleep?.quality,
    leftAmount: activity.pumping?.leftAmount?.toString(),
    rightAmount: activity.pumping?.rightAmount?.toString(),
    inventoryAction: activity.pumping?.inventoryAction,
    name: activity.medicine?.name ?? activity.supplement?.name ?? activity.vaccine?.name,
    dose: activity.medicine?.dose?.toString() ?? activity.supplement?.dose?.toString() ?? activity.vaccine?.dose,
    weight: activity.measurement?.weight?.toString(),
    weightUnit: activity.measurement?.weightUnit,
    length: activity.measurement?.length?.toString(),
    lengthUnit: activity.measurement?.lengthUnit,
    headCircumference: activity.measurement?.headCircumference?.toString(),
    headUnit: activity.measurement?.headUnit,
    temperature: activity.measurement?.temperature?.toString(),
    temperatureUnit: activity.measurement?.temperatureUnit,
    measurementType: activity.measurement?.measurementType,
    title: activity.milestone?.title,
    category: activity.milestone?.category ?? activity.note?.category,
    text: activity.note?.text,
    bathType: activity.bath?.bathType,
    products: activity.bath?.products,
    waterTemp: activity.bath?.waterTemp,
    activityName: activity.play?.activityName,
    intensity: activity.play?.intensity ?? activity.mood?.intensity,
    mood: activity.mood?.mood,
    context: activity.mood?.context,
    lot: activity.vaccine?.lot,
    provider: activity.vaccine?.provider,
    dueDate: activity.vaccine?.dueDate ? activity.vaccine.dueDate.toISOString().slice(0, 10) : "",
    documentUrl: activity.vaccine?.documentUrl,
    action: activity.milkInventory?.action,
    storage: activity.milkInventory?.storage,
    label: activity.milkInventory?.label
  };
}
