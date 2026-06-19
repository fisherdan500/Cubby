import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityForm } from "@/components/forms/activity-form";
import { Card } from "@/components/ui/card";
import { activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdHome } from "@/server/services/households";

export default async function LogActivityPage({
  params,
  searchParams
}: {
  params: { type: string };
  searchParams: { babyId?: string; date?: string };
}) {
  const type = params.type as ActivityTypeName;
  if (!activityTypes.includes(type)) notFound();
  const user = await requireUserPage();
  const home = await getHouseholdHome(user.id);
  if (!home) redirect("/onboarding");
  const babies = home.household.babies.map((baby) => ({
    id: baby.id,
    name: baby.name
  }));

  return (
    <AppShell title={`Log ${activityLabels[type]}`} userName={user.name}>
      <div>
        <Card className="mx-auto max-w-2xl">
          {babies.length ? (
            <ActivityForm
              babies={babies}
              type={type}
              selectedBabyId={searchParams.babyId}
              returnDate={searchParams.date}
              appTimeZone={env.APP_TIMEZONE}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Add a baby before logging activities.</p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
