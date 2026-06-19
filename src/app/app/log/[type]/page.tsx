import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityForm } from "@/components/forms/activity-form";
import { Card } from "@/components/ui/card";
import { activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdHome } from "@/server/services/households";

export default async function LogActivityPage({ params }: { params: { type: string } }) {
  const type = params.type as ActivityTypeName;
  if (!activityTypes.includes(type)) notFound();
  const user = await requireUserPage();
  const home = await getHouseholdHome(user.id);
  if (!home) redirect("/onboarding");
  const babies = home.household.babies.map((baby) => ({
    id: baby.id,
    name: baby.name,
    timezone: baby.timezone
  }));

  return (
    <AppShell title={`Log ${activityLabels[type]}`} userName={user.name}>
      <div className="md:pl-56">
        <Card className="mx-auto max-w-2xl">
          {babies.length ? (
            <ActivityForm babies={babies} type={type} />
          ) : (
            <p className="text-sm text-muted-foreground">Add a baby before logging activities.</p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
