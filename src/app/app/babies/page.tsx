import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BabyDeleteDialog } from "@/components/actions/baby-delete-dialog";
import { BabyLifecycleButton } from "@/components/actions/baby-lifecycle-button";
import { BabyEditForm } from "@/components/forms/baby-edit-form";
import { BabyForm } from "@/components/forms/baby-form";
import { Card } from "@/components/ui/card";
import { formatCalendarDate } from "@/lib/timezone";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getHouseholdHome, listRemovableBabyIds } from "@/server/services/households";

function isoDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

export default async function BabiesPage() {
  const { user } = await requireSettingsPage("baby.manage");
  const home = await getHouseholdHome({ includeInactive: true });
  if (!home) redirect("/onboarding");
  // Which babies could be removed outright; the delete itself checks again before writing.
  const removable = new Set(await listRemovableBabyIds(home.household.babies.map((baby) => baby.id)));

  return (
    <AppShell title="Babies" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <div className="grid gap-4 md:grid-cols-[1fr_360px]">
        <section className="space-y-3">
          {home.household.babies.map((baby) => {
            const isInactive = Boolean(baby.inactiveAt);
            return (
              <Card key={baby.id}>
              <h2 className="text-lg font-bold">{baby.name}</h2>
              <p className="text-sm text-muted-foreground">
                {baby.birthDate ? `Born ${formatCalendarDate(baby.birthDate)}` : "Birth date not set"}
              </p>
              {isInactive ? <p className="mt-1 text-sm font-bold text-muted-foreground">Inactive</p> : null}
              {baby.notes ? <p className="mt-2 text-sm">{baby.notes}</p> : null}
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-bold">Edit details</summary>
                <div className="mt-3">
                  <BabyEditForm
                    baby={{
                      id: baby.id,
                      name: baby.name,
                      birthDate: isoDate(baby.birthDate),
                      notes: baby.notes,
                      feedingWarningMinutes: baby.feedingWarningMinutes,
                      diaperWarningMinutes: baby.diaperWarningMinutes,
                      sleepWarningMinutes: baby.sleepWarningMinutes
                    }}
                  />
                </div>
              </details>
              <div className="mt-3 flex flex-wrap gap-2">
                <BabyLifecycleButton babyId={baby.id} babyName={baby.name} inactive={isInactive} />
                <BabyDeleteDialog babyId={baby.id} babyName={baby.name} canRemove={removable.has(baby.id)} />
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
