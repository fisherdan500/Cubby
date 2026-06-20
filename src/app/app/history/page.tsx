import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { DeleteActivityButton } from "@/components/actions/activity-actions";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { describeActivity, formatDateTime } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { listActivities } from "@/server/services/activities";
import { getHeaderBabySelector } from "@/server/services/baby-selector";

export default async function HistoryPage({ searchParams }: { searchParams: { babyId?: string; type?: string; search?: string } }) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const activities = await listActivities({
    babyId: babySelector?.selectedBabyId ?? searchParams.babyId,
    type: searchParams.type,
    search: searchParams.search
  });

  return (
    <AppShell title="Full Log" userName={user.name} babySelector={babySelector}>
      <div className="space-y-4">
        <Card className="w-fit max-w-full">
          <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
            {babySelector ? <input type="hidden" name="babyId" value={babySelector.selectedBabyId} /> : null}
            <select name="type" defaultValue={searchParams.type ?? ""} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 sm:w-48">
              <option value="">All types</option>
              {activityTypes.map((type) => (
                <option key={type} value={type}>
                  {activityLabels[type]}
                </option>
              ))}
            </select>
            <input
              name="search"
              defaultValue={searchParams.search ?? ""}
              placeholder="Search notes, meds, milestones"
              className="min-h-11 w-full rounded-lg border border-border bg-card px-3 sm:w-72"
            />
          </AutoSubmitForm>
        </Card>

        <div className="space-y-3">
          {activities.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">No matching activity yet.</p>
            </Card>
          ) : null}
          {activities.map((activity) => (
            <Card key={activity.id} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold">{activityLabels[activity.type as ActivityTypeName]}</p>
                  <p className="text-sm text-muted-foreground">
                    {activity.baby.name} - {formatDateTime(activity.occurredAt)} -{" "}
                    {activity.actorMember.displayName ?? activity.actorMember.user.name}
                  </p>
                  <p className="mt-1 text-sm">{describeActivity(activity)}</p>
                </div>
                <div className="flex gap-2">
                  <Link href={`/app/activities/${activity.id}/edit`}>
                    <Button variant="secondary">Edit</Button>
                  </Link>
                  <DeleteActivityButton id={activity.id} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
