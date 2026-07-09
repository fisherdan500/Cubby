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

const primaryQuickActionTypes = new Set<ActivityTypeName>(["sleep", "feeding", "diaper"]);
const primaryQuickActions = quickActions.filter(([type]) => primaryQuickActionTypes.has(type));
const secondaryQuickActions = quickActions.filter(([type]) => !primaryQuickActionTypes.has(type));

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
              <Timeline
                activities={currentDashboard.activities}
                timeZone={currentDashboard.selectedDate.timezone}
                returnTo={`/app?${new URLSearchParams({ babyId: baby.id, date: currentDashboard.selectedDate.key }).toString()}`}
              />
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function QuickActionRail({ dashboard }: { dashboard: DashboardWithBaby }) {
  return (
    <section className="space-y-3 border-y border-border bg-primary/15 px-1 py-3 sm:px-2 sm:py-4">
      <div className="grid grid-cols-3 gap-2 sm:max-w-xl">
        {primaryQuickActions.map(([type, Icon]) => (
          <QuickActionLink key={type} type={type} Icon={Icon} dashboard={dashboard} priority="primary" />
        ))}
      </div>

      <details className="group sm:hidden">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-center rounded-lg border border-border bg-card/70 text-sm font-black text-foreground marker:hidden">
          More
        </summary>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {secondaryQuickActions.map(([type, Icon]) => (
            <QuickActionLink key={type} type={type} Icon={Icon} dashboard={dashboard} priority="secondary" />
          ))}
        </div>
      </details>

      <div className="hidden gap-2 overflow-x-auto sm:flex">
        {secondaryQuickActions.map(([type, Icon]) => (
          <QuickActionLink key={type} type={type} Icon={Icon} dashboard={dashboard} priority="secondary" />
        ))}
      </div>
    </section>
  );
}

function QuickActionLink({
  type,
  Icon,
  dashboard,
  priority
}: {
  type: ActivityTypeName;
  Icon: React.ElementType;
  dashboard: DashboardWithBaby;
  priority: "primary" | "secondary";
}) {
  const badge = elapsedBadge(type, dashboard);
  const active = dashboard.activeTimers.some((timer) => timer.type === type);
  const primary = priority === "primary";

  return (
    <Link
      href={activityLogHref(type, dashboard)}
      className={
        primary
          ? "rounded-lg border border-border bg-card/70 p-2 text-center shadow-soft transition hover:bg-muted"
          : "min-w-0 rounded-lg p-1 text-center transition hover:bg-muted sm:min-w-20"
      }
    >
      <div className="flex flex-col items-center gap-1.5">
        <div className={`flex ${primary ? "h-5" : "h-4"} items-center justify-center`}>
          {badge ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-black leading-none ${elapsedBadgeClasses[type]}`}>
              {badge}
            </span>
          ) : null}
        </div>
        <div className={`flex items-center justify-center rounded-full shadow-soft ${activityAccent[type]} ${primary ? "h-16 w-16" : "h-12 w-12"}`}>
          <Icon className={primary ? "h-8 w-8" : "h-6 w-6"} />
        </div>
        <p className={`${primary ? "text-sm" : "text-[11px]"} font-black leading-tight text-muted-foreground`}>
          {quickActionLabel(type)}
        </p>
        {active ? (
          <span className="rounded-full bg-green-500 px-2 py-0.5 text-[10px] font-black leading-none text-slate-950">Active</span>
        ) : null}
      </div>
    </Link>
  );
}

function activityLogHref(type: ActivityTypeName, dashboard: DashboardWithBaby) {
  const returnTo = `/app?${new URLSearchParams({ babyId: dashboard.baby.id, date: dashboard.selectedDate.key }).toString()}`;
  const params = new URLSearchParams({
    babyId: dashboard.baby.id,
    date: dashboard.selectedDate.key,
    returnTo
  });
  return `/app/log/${type}?${params.toString()}`;
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
  const items = [
    summary.sleep.count
      ? {
          key: "sleep",
          icon: <Bed className="h-5 w-5 text-slate-300" />,
          value: formatDuration(summary.sleep.seconds) || "0 min",
          label: "Total Sleep"
        }
      : null,
    summary.feeding.count
      ? {
          key: "feeding",
          icon: <Milk className="h-5 w-5 text-sky-300" />,
          value: String(summary.feeding.count),
          label: summary.feeding.amount ? `${summary.feeding.amount.toFixed(1)} oz` : "Feeds"
        }
      : null,
    summary.diaper.count
      ? {
          key: "diaper",
          icon: <Droplets className="h-5 w-5 text-teal-300" />,
          value: String(summary.diaper.count),
          label: diaperSummaryLabel(summary.diaper)
        }
      : null,
    summary.bath.count
      ? {
          key: "bath",
          icon: <Bath className="h-5 w-5 text-cyan-300" />,
          value: String(summary.bath.count),
          label: summary.bath.count === 1 ? "Bath" : "Baths"
        }
      : null,
    summary.pumping.count
      ? {
          key: "pumping",
          icon: <Milk className="h-5 w-5 text-fuchsia-300" />,
          value: summary.pumping.amount ? `${summary.pumping.amount.toFixed(1)} oz` : String(summary.pumping.count),
          label: summary.pumping.amount ? "Pumped" : "Pump"
        }
      : null,
    summary.milestone.count
      ? {
          key: "milestone",
          icon: <Trophy className="h-5 w-5 text-indigo-300" />,
          value: String(summary.milestone.count),
          label: summary.milestone.count === 1 ? "Milestone" : "Milestones"
        }
      : null,
    summary.medicine.count
      ? {
          key: "medicine",
          icon: <Pill className="h-5 w-5 text-emerald-300" />,
          value: String(summary.medicine.count),
          label: "Medicine"
        }
      : null,
    summary.supplement.count
      ? {
          key: "supplement",
          icon: <Plus className="h-5 w-5 text-violet-300" />,
          value: String(summary.supplement.count),
          label: summary.supplement.count === 1 ? "Supplement" : "Supplements"
        }
      : null,
    summary.vaccine.count
      ? {
          key: "vaccine",
          icon: <Syringe className="h-5 w-5 text-red-300" />,
          value: String(summary.vaccine.count),
          label: summary.vaccine.count === 1 ? "Vaccine" : "Vaccines"
        }
      : null,
    summary.play.count
      ? {
          key: "play",
          icon: <Wand2 className="h-5 w-5 text-lime-300" />,
          value: summary.play.seconds ? formatDuration(summary.play.seconds) || "0 min" : String(summary.play.count),
          label: summary.play.seconds ? "Play Time" : "Play"
        }
      : null
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-black">Daily Summary</h2>
      {items.length ? (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-2">
          {items.map((item) => (
            <SummaryItem key={item.key} icon={item.icon} value={item.value} label={item.label} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No summary activity for this date.</p>
      )}
    </section>
  );
}

function diaperSummaryLabel(summary: DashboardWithBaby["dailySummary"]["diaper"]) {
  const parts = [
    summary.wet ? `${summary.wet} wet` : null,
    summary.dirty ? `${summary.dirty} dirty` : null,
    summary.mixed ? `${summary.mixed} mixed` : null,
    summary.dry ? `${summary.dry} dry` : null
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Diapers";
}

function SummaryItem({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="flex min-h-14 min-w-0 items-center gap-2 rounded-md border border-border bg-card/60 p-2 sm:min-w-32 sm:px-3">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="truncate text-sm font-black leading-none sm:text-base">{value}</p>
        <p className="truncate text-xs font-semibold text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

type TimelineActivity = Parameters<typeof describeActivity>[0] & { id: string; occurredAt: Date; type: string };

function Timeline({ activities, timeZone, returnTo }: { activities: TimelineActivity[]; timeZone: string; returnTo: string }) {
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
                  href={activityEditHref(activity.id, returnTo)}
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

function activityEditHref(activityId: string, returnTo: string) {
  return `/app/activities/${activityId}/edit?${new URLSearchParams({ returnTo }).toString()}`;
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
