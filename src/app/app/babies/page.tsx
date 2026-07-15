import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BabyLifecycleButton } from "@/components/actions/baby-lifecycle-button";
import { BabyForm } from "@/components/forms/baby-form";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getHouseholdHome } from "@/server/services/households";

export default async function BabiesPage() {
  const { user } = await requireSettingsPage("baby.manage");
  const home = await getHouseholdHome(user.id, { includeInactive: true });
  if (!home) redirect("/onboarding");

  return (
    <AppShell title="Babies" userName={user.name}>
      <div className="grid gap-4 md:grid-cols-[1fr_360px]">
        <section className="space-y-3">
          {home.household.babies.map((baby) => {
            const isInactive = Boolean(baby.inactiveAt);
            return (
              <Card key={baby.id}>
              <h2 className="text-lg font-bold">{baby.name}</h2>
              <p className="text-sm text-muted-foreground">
                {baby.birthDate ? `Born ${baby.birthDate.toLocaleDateString()}` : "Birth date not set"}
              </p>
              {isInactive ? <p className="mt-1 text-sm font-bold text-muted-foreground">Inactive</p> : null}
              {baby.notes ? <p className="mt-2 text-sm">{baby.notes}</p> : null}
              <div className="mt-3">
                <BabyLifecycleButton babyId={baby.id} babyName={baby.name} inactive={isInactive} />
              </div>
              </Card>
            );
          })}
        </section>
        <Card>
          <h2 className="mb-3 text-lg font-bold">Add baby</h2>
          <BabyForm />
        </Card>
      </div>
    </AppShell>
  );
}
