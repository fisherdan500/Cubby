import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Baby, Bed, Droplets, Milk, Pill, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StopTimerButton, UndoLastButton } from "@/components/actions/activity-actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { describeActivity, formatDateTime } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getDashboard, warningState } from "@/server/services/dashboard";

const quickActions: Array<[ActivityTypeName, React.ElementType]> = [
  ["feeding", Milk],
  ["diaper", Droplets],
  ["sleep", Bed],
  ["pumping", Milk],
  ["medicine", Pill],
  ["note", Plus]
];

export default async function DashboardPage({ searchParams }: { searchParams: { babyId?: string } }) {
  const user = await requireUserPage();
  const dashboard = await getDashboard(user.id, searchParams.babyId);
  if (!dashboard?.home) redirect("/onboarding");
  const { baby } = dashboard;

  return (
    <AppShell title="Today" userName={user.name}>
      {!baby ? (
        <Card>
          <h2 className="text-lg font-bold">Add your first baby</h2>
          <p className="mb-4 text-sm text-muted-foreground">Cubby needs a baby profile before logging activities.</p>
          <Link href="/app/babies">
            <Button>Add baby</Button>
          </Link>
        </Card>
      ) : (
        <div className="space-y-5 md:pl-56">
          <form className="flex gap-2">
            <select name="babyId" defaultValue={baby.id} className="min-h-11 flex-1 rounded-lg border border-border bg-card px-3">
              {dashboard.home.household.babies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <Button>Switch</Button>
          </form>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {["feeding", "diaper", "sleep", "medicine"].map((type) => (
              <Card key={type}>
                <p className="text-sm text-muted-foreground">{activityLabels[type as ActivityTypeName]}</p>
                <p className="mt-1 text-3xl font-black">{dashboard.summaries[type] ?? 0}</p>
              </Card>
            ))}
          </section>

          <Warnings dashboard={dashboard} />

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            {quickActions.map(([type, Icon]) => (
              <Link key={type} href={`/app/log/${type}`}>
                <Button className="h-20 w-full flex-col text-base">
                  <Icon className="h-6 w-6" />
                  {activityLabels[type]}
                </Button>
              </Link>
            ))}
          </section>

          {dashboard.activeTimers.length ? (
            <Card className="space-y-3">
              <h2 className="text-lg font-bold">Active timers</h2>
              {dashboard.activeTimers.map((timer) => (
                <div key={timer.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
                  <div>
                    <p className="font-semibold">{activityLabels[timer.type as ActivityTypeName]}</p>
                    <p className="text-sm text-muted-foreground">Started {formatDateTime(timer.startedAt)}</p>
                  </div>
                  <StopTimerButton id={timer.id} />
                </div>
              ))}
            </Card>
          ) : null}

          <section className="grid gap-3 md:grid-cols-3">
            <LastCard title="Last feeding" activity={dashboard.lastFeeding} />
            <LastCard title="Last diaper" activity={dashboard.lastDiaper} />
            <LastCard title="Last sleep" activity={dashboard.lastSleep} />
          </section>

          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">Recent activity</h2>
              <UndoLastButton />
            </div>
            {dashboard.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet. The first log will show up here.</p>
            ) : (
              <div className="space-y-2">
                {dashboard.activities.map((activity) => (
                  <Link
                    key={activity.id}
                    href={`/app/activities/${activity.id}/edit`}
                    className="block rounded-lg border border-border p-3 hover:bg-muted"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold">{activityLabels[activity.type as ActivityTypeName]}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(activity.occurredAt)}</p>
                    </div>
                    <p className="text-sm text-muted-foreground">{describeActivity(activity)}</p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function LastCard({ title, activity }: { title: string; activity: Parameters<typeof describeActivity>[0] | null }) {
  return (
    <Card>
      <p className="text-sm text-muted-foreground">{title}</p>
      {activity ? (
        <>
          <p className="mt-1 font-bold">{formatDateTime(activity.occurredAt)}</p>
          <p className="text-sm text-muted-foreground">{describeActivity(activity)}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">Nothing logged yet.</p>
      )}
    </Card>
  );
}

function Warnings({ dashboard }: { dashboard: NonNullable<Awaited<ReturnType<typeof getDashboard>>> }) {
  const warnings = warningState({
    lastFeeding: dashboard.lastFeeding,
    lastDiaper: dashboard.lastDiaper,
    activeTimers: dashboard.activeTimers
  });
  const items = [
    warnings.feedingLate ? "Long time since feeding" : "",
    warnings.diaperLate ? "Long time since diaper" : "",
    warnings.timerLong ? "Timer running unusually long" : ""
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <Card className="border-accent bg-accent/10">
      <div className="flex gap-3">
        <AlertTriangle className="mt-1 h-5 w-5 text-accent" />
        <div>
          <h2 className="font-bold">Needs a glance</h2>
          <p className="text-sm text-muted-foreground">{items.join(" · ")}</p>
        </div>
      </div>
    </Card>
  );
}
