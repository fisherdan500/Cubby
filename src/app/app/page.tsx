import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  Bath,
  Bed,
  Droplets,
  Milk,
  NotebookText,
  Package,
  Pill,
  Plus,
  Ruler,
  Smile,
  Syringe,
  Trophy,
  Wand2
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PauseTimerButton, ResumeTimerButton, StopTimerButton, UndoLastButton } from "@/components/actions/activity-actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { activityAccent, activityLabels, type ActivityTypeName } from "@/domain/activity";
import { describeActivity, formatDateTime, formatDuration } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getDashboard, warningState } from "@/server/services/dashboard";

const quickActions: Array<[ActivityTypeName, React.ElementType]> = [
  ["feeding", Milk],
  ["diaper", Droplets],
  ["sleep", Bed],
  ["pumping", Milk],
  ["medicine", Pill],
  ["measurement", Ruler],
  ["milestone", Trophy],
  ["note", NotebookText],
  ["bath", Bath],
  ["play", Wand2],
  ["mood", Smile],
  ["supplement", Plus],
  ["vaccine", Syringe],
  ["milk_inventory", Package]
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
        <div className="space-y-5">
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

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric label="Total sleep" value={formatDuration(dashboard.dailySummary.sleepSeconds) || "0 min"} />
            <Metric label="Feeds" value={String(dashboard.dailySummary.feeds)} />
            <Metric label="Wet diapers" value={String(dashboard.dailySummary.wetDiapers)} />
            <Metric label="Dirty diapers" value={String(dashboard.dailySummary.dirtyDiapers)} />
            <Metric label="Pumped" value={dashboard.dailySummary.pumped ? `${dashboard.dailySummary.pumped.toFixed(1)} oz` : "0 oz"} />
          </section>

          <Warnings dashboard={dashboard} />

          <section className="flex gap-3 overflow-x-auto border-y border-border bg-primary/15 px-1 py-4">
            {quickActions.map(([type, Icon]) => (
              <Link key={type} href={`/app/log/${type}`} className="min-w-24">
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className={`flex h-14 w-14 items-center justify-center rounded-full shadow-soft ${activityAccent[type]}`}>
                    <Icon className="h-7 w-7" />
                  </div>
                  <p className="text-xs font-bold text-muted-foreground">{activityLabels[type]}</p>
                  {dashboard.activeTimers.some((timer) => timer.type === type) ? (
                    <span className="rounded-full bg-green-500 px-2 py-0.5 text-[11px] font-black text-slate-950">Active</span>
                  ) : null}
                </div>
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
                    <p className="text-sm text-muted-foreground">
                      {timer.timerState === "paused" ? "Paused" : "Started"} {formatDateTime(timer.startedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {timer.timerState === "paused" ? <ResumeTimerButton id={timer.id} /> : <PauseTimerButton id={timer.id} />}
                    <StopTimerButton id={timer.id} />
                  </div>
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
              <Timeline activities={dashboard.activities} />
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </Card>
  );
}

type TimelineActivity = Parameters<typeof describeActivity>[0] & { id: string; occurredAt: Date; type: string };

function Timeline({ activities }: { activities: TimelineActivity[] }) {
  const groups = activities.reduce<Record<string, TimelineActivity[]>>((acc, activity) => {
    const label = periodLabel(activity.occurredAt);
    acc[label] = acc[label] ?? [];
    acc[label].push(activity);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      {Object.entries(groups).map(([label, items]) => (
        <div key={label} className="relative border-l border-border pl-6">
          <h3 className="mb-3 text-sm font-black text-foreground">{label}</h3>
          <div className="space-y-3">
            {items.map((activity) => {
              const type = activity.type as ActivityTypeName;
              return (
                <Link
                  key={activity.id}
                  href={`/app/activities/${activity.id}/edit`}
                  className="relative block rounded-md border border-border bg-background/45 p-3 hover:bg-muted"
                >
                  <span className={`absolute -left-[33px] top-4 h-4 w-4 rounded-full ring-4 ring-background ${activityAccent[type].split(" ")[0]}`} />
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-black">{activityLabels[type]}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{describeActivity(activity)}</p>
                    </div>
                    <p className="shrink-0 text-right text-xs font-semibold text-muted-foreground">
                      {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(activity.occurredAt)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function periodLabel(date: Date) {
  const hour = date.getHours();
  if (hour < 5) return "Overnight";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 21) return "Evening";
  return "Night";
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
    activeTimers: dashboard.activeTimers,
    feedingWarningMinutes: dashboard.baby?.feedingWarningMinutes,
    diaperWarningMinutes: dashboard.baby?.diaperWarningMinutes,
    sleepWarningMinutes: dashboard.baby?.sleepWarningMinutes
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
          <p className="text-sm text-muted-foreground">{items.join(" - ")}</p>
        </div>
      </div>
    </Card>
  );
}
