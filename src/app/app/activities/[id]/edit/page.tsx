import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { DeleteActivityButton } from "@/components/actions/activity-actions";
import { ActivityForm } from "@/components/forms/activity-form";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { requireUserPage } from "@/server/auth/session";
import { getActivity } from "@/server/services/activities";
import { getHouseholdHome } from "@/server/services/households";

export default async function EditActivityPage({ params }: { params: { id: string } }) {
  const user = await requireUserPage();
  const home = await getHouseholdHome(user.id);
  if (!home) redirect("/onboarding");
  const activity = await getActivity(params.id).catch(() => null);
  if (!activity) notFound();
  const type = activity.type as ActivityTypeName;
  const babies = home.household.babies.map((baby) => ({ id: baby.id, name: baby.name, timezone: baby.timezone }));
  const initial = serializeActivity(activity);

  return (
    <AppShell title={`Edit ${activityLabels[type]}`} userName={user.name}>
      <div className="mx-auto max-w-2xl space-y-4 md:pl-56">
        <Card>
          <ActivityForm babies={babies} type={type} activityId={activity.id} initial={initial} />
        </Card>
        <DeleteActivityButton id={activity.id} />
      </div>
    </AppShell>
  );
}

function localValue(date?: Date | null) {
  if (!date) return "";
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function serializeActivity(activity: Awaited<ReturnType<typeof getActivity>>) {
  return {
    id: activity.id,
    babyId: activity.babyId,
    occurredAt: localValue(activity.occurredAt),
    startedAt: localValue(activity.startedAt),
    endedAt: localValue(activity.endedAt),
    timezone: activity.timezone,
    notes: activity.notes,
    mode: activity.feeding?.mode,
    amount: activity.feeding?.amount?.toString() ?? activity.pumping?.amount?.toString(),
    unit: activity.feeding?.unit ?? activity.pumping?.unit ?? activity.medicine?.unit,
    side: activity.feeding?.side,
    kind: activity.diaper?.kind,
    color: activity.diaper?.color,
    consistency: activity.diaper?.consistency,
    rashConcern: activity.diaper?.rashConcern,
    leftAmount: activity.pumping?.leftAmount?.toString(),
    rightAmount: activity.pumping?.rightAmount?.toString(),
    name: activity.medicine?.name,
    dose: activity.medicine?.dose?.toString(),
    weight: activity.measurement?.weight?.toString(),
    weightUnit: activity.measurement?.weightUnit,
    length: activity.measurement?.length?.toString(),
    lengthUnit: activity.measurement?.lengthUnit,
    headCircumference: activity.measurement?.headCircumference?.toString(),
    headUnit: activity.measurement?.headUnit,
    title: activity.milestone?.title,
    category: activity.milestone?.category ?? activity.note?.category,
    text: activity.note?.text
  };
}
