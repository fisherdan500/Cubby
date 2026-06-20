import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Bath,
  Bed,
  ChevronLeft,
  ChevronRight,
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
import { DashboardWarnings } from "@/components/dashboard/dashboard-warnings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { activityAccent, activityLabels, type ActivityTypeName } from "@/domain/activity";
import { describeActivity, formatDateTime, formatDuration, formatElapsedBadge } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getDashboard } from "@/server/services/dashboard";

const quickActions: Array<[ActivityTypeName, React.ElementType]> = [
  ["sleep", Bed],
  ["feeding", Milk],
  ["diaper", Droplets],
  ["note", NotebookText],
  ["bath", Bath],
  ["pumping", Milk],
  ["measurement", Ruler],
  ["milestone", Trophy],
  ["medicine", Pill],
  ["play", Wand2],
  ["mood", Smile],
  ["supplement", Plus],
  ["vaccine", Syringe],
  ["milk_inventory", Package]
];

const elapsedBadgeClasses: Partial<Record<ActivityTypeName, string>> = {
  sleep: "bg-slate-200 text-slate-950",
  feeding: "bg-sky-300 text-slate-950",
  diaper: "bg-teal-300 text-slate-950"
};

type DashboardData = NonNullable<Awaited<ReturnType<typeof getDashboard>>>;
type DashboardWithBaby = DashboardData & {
  baby: NonNullable<DashboardData["baby"]>;
  selectedDate: NonNullable<DashboardData["selectedDate"]>;
  dailySummary: NonNullable<DashboardData["dailySummary"]>;
};

export default async function DashboardPage({ searchParams }: { searchParams: { babyId?: string; date?: string } }) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const dashboard = await getDashboard(user.id, { babyId: babySelector?.selectedBabyId ?? searchParams.babyId, date: searchParams.date });
  if (!dashboard?.home) redirect("/onboarding");
  const { baby } = dashboard;
  const currentDashboard = dashboard as DashboardWithBaby;

  return (
    <AppShell title="Log Entry" userName={user.name} babySelector={babySelector}>
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
          <QuickActionRail dashboard={currentDashboard} />
          <DateNavigator babyId={baby.id} selectedDate={currentDashboard.selectedDate} />
          <DailySummary summary={currentDashboard.dailySummary} />
          <DashboardWarnings warnings={currentDashboard.warnings} />

          {currentDashboard.activeTimers.length ? (
            <Card className="space-y-3">
              <h2 className="text-lg font-bold">Active timers</h2>
              {currentDashboard.activeTimers.map((timer) => (
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

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">Daily log</h2>
              <UndoLastButton />
            </div>
            {currentDashboard.activities.length === 0 ? (
              <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No activity for this date.</p>
            ) : (
              <Timeline activities={currentDashboard.activities} timeZone={currentDashboard.selectedDate.timezone} />
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function QuickActionRail({ dashboard }: { dashboard: DashboardWithBaby }) {
  return (
    <section className="flex gap-3 overflow-x-auto border-y border-border bg-primary/15 px-1 py-4">
      {quickActions.map(([type, Icon]) => {
        const badge = elapsedBadge(type, dashboard);
        return (
          <Link
            key={type}
            href={`/app/log/${type}?babyId=${dashboard.baby.id}&date=${dashboard.selectedDate.key}`}
            className="min-w-24"
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-5 items-center justify-center">
                {badge ? (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${elapsedBadgeClasses[type]}`}>
                    {badge}
                  </span>
                ) : null}
              </div>
              <div className={`flex h-14 w-14 items-center justify-center rounded-full shadow-soft ${activityAccent[type]}`}>
                <Icon className="h-7 w-7" />
              </div>
              <p className="text-xs font-bold text-muted-foreground">{quickActionLabel(type)}</p>
              {dashboard.activeTimers.some((timer) => timer.type === type) ? (
                <span className="rounded-full bg-green-500 px-2 py-0.5 text-[11px] font-black text-slate-950">Active</span>
              ) : null}
            </div>
          </Link>
        );
      })}
    </section>
  );
}

function DateNavigator({ babyId, selectedDate }: { babyId: string; selectedDate: DashboardWithBaby["selectedDate"] }) {
  return (
    <nav className="flex items-center justify-center gap-5">
      <Link
        href={`/app?babyId=${babyId}&date=${selectedDate.previous}`}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Previous day"
      >
        <ChevronLeft className="h-5 w-5" />
      </Link>
      <p className="min-w-40 text-center text-sm font-black">{selectedDate.label}</p>
      <Link
        href={`/app?babyId=${babyId}&date=${selectedDate.next}`}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Next day"
      >
        <ChevronRight className="h-5 w-5" />
      </Link>
    </nav>
  );
}

function DailySummary({ summary }: { summary: DashboardWithBaby["dailySummary"] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-black">Daily Summary</h2>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <SummaryItem icon={<Bed className="h-5 w-5 text-slate-300" />} value={formatDuration(summary.sleepSeconds) || "0 min"} label="Total Sleep" />
        <SummaryItem
          icon={<Milk className="h-5 w-5 text-sky-300" />}
          value={String(summary.feeds)}
          label={summary.feedAmount ? `${summary.feedAmount.toFixed(1)} oz` : "Feeds"}
        />
        <SummaryItem icon={<Droplets className="h-5 w-5 text-teal-300" />} value={String(summary.wetDiapers)} label="Wet Diapers" />
        <SummaryItem icon={<Droplets className="h-5 w-5 text-orange-400" />} value={String(summary.dirtyDiapers)} label="Poops" />
        <SummaryItem icon={<Milk className="h-5 w-5 text-fuchsia-300" />} value={summary.pumped ? `${summary.pumped.toFixed(1)} oz` : "0 oz"} label="Pumped" />
      </div>
    </section>
  );
}

function SummaryItem({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <div>
        <p className="text-lg font-black leading-none">{value}</p>
        <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

type TimelineActivity = Parameters<typeof describeActivity>[0] & { id: string; occurredAt: Date; type: string };

function Timeline({ activities, timeZone }: { activities: TimelineActivity[]; timeZone: string }) {
  const groups = activities.reduce<Record<string, TimelineActivity[]>>((acc, activity) => {
    const label = periodLabel(activity.occurredAt, timeZone);
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
                      {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone }).format(activity.occurredAt)}
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

function periodLabel(date: Date, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date));
  if (hour < 5) return "Overnight";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 21) return "Evening";
  return "Night";
}

function elapsedBadge(type: ActivityTypeName, dashboard: DashboardData) {
  if (type === "sleep") return formatElapsedBadge(dashboard.lastSleep?.endedAt ?? dashboard.lastSleep?.occurredAt);
  if (type === "feeding") return formatElapsedBadge(dashboard.lastFeeding?.occurredAt);
  if (type === "diaper") return formatElapsedBadge(dashboard.lastDiaper?.occurredAt);
  return null;
}

function quickActionLabel(type: ActivityTypeName) {
  if (type === "feeding") return "Feed";
  if (type === "pumping") return "Pump";
  return activityLabels[type];
}
