import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ActivityArtwork } from "@/components/activity-artwork";
import { PauseTimerButton, ResumeTimerButton, StopTimerButton, UndoLastButton } from "@/components/actions/activity-actions";
import { DashboardWarnings } from "@/components/dashboard/dashboard-warnings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  activityLabels,
  filterActivitiesBySummaryType,
  isDailySummaryActivityType,
  type ActivityTypeName,
  type DailySummaryActivityType
} from "@/domain/activity";
import { describeActivity, formatDateTime, formatDuration, formatElapsedBadge } from "@/lib/activity-format";
import { activityDetailHref } from "@/lib/activity-navigation";
import { requireUserPage } from "@/server/auth/session";
import { getDashboardPageData } from "@/server/services/dashboard";

const quickActions: ActivityTypeName[] = [
  "sleep", "feeding", "diaper", "note", "bath", "pumping", "measurement",
  "milestone", "medicine", "play", "mood", "supplement", "vaccine", "milk_inventory"
];

const primaryQuickActionTypes = new Set<ActivityTypeName>(["sleep", "feeding", "diaper"]);
const primaryQuickActions = quickActions.filter((type) => primaryQuickActionTypes.has(type));
const secondaryQuickActions = quickActions.filter((type) => !primaryQuickActionTypes.has(type));

const elapsedBadgeClasses: Partial<Record<ActivityTypeName, string>> = {
  sleep: "activity-tone-sleep text-foreground",
  feeding: "activity-tone-feeding text-foreground",
  diaper: "activity-tone-diaper text-foreground"
};

type DashboardPageData = NonNullable<Awaited<ReturnType<typeof getDashboardPageData>>>;
type DashboardData = DashboardPageData["dashboard"];
type DashboardWithBaby = DashboardData & {
  baby: NonNullable<DashboardData["baby"]>;
  selectedDate: NonNullable<DashboardData["selectedDate"]>;
  dailySummary: NonNullable<DashboardData["dailySummary"]>;
};

export default async function DashboardPage({
  searchParams
}: {
  searchParams: { babyId?: string; date?: string; summaryType?: string };
}) {
  const user = await requireUserPage();
  const pageData = await getDashboardPageData(user.id, {
    babyId: searchParams.babyId,
    date: searchParams.date
  });
  if (!pageData?.dashboard.home) redirect("/onboarding");
  const { dashboard, babySelector } = pageData;
  const { baby } = dashboard;
  const currentDashboard = dashboard as DashboardWithBaby;
  const requestedSummaryType = isDailySummaryActivityType(searchParams.summaryType) ? searchParams.summaryType : undefined;
  const selectedSummaryType = baby && requestedSummaryType && currentDashboard.dailySummary[requestedSummaryType].count
    ? requestedSummaryType
    : undefined;
  const visibleActivities = baby ? filterActivitiesBySummaryType(currentDashboard.activities, selectedSummaryType) : [];

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
          <DailySummary
            summary={currentDashboard.dailySummary}
            babyId={baby.id}
            selectedDate={currentDashboard.selectedDate.key}
            selectedType={selectedSummaryType}
          />
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
            {visibleActivities.length === 0 ? (
              <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No activity for this date.</p>
            ) : (
              <Timeline
                activities={visibleActivities}
                timeZone={currentDashboard.selectedDate.timezone}
                returnTo={dashboardReturnTo(baby.id, currentDashboard.selectedDate.key, selectedSummaryType)}
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
    <section className="space-y-3 border-y border-border bg-surface/70 px-1 py-3 sm:px-2 sm:py-4">
      <div className="grid grid-cols-3 gap-2 sm:max-w-xl">
        {primaryQuickActions.map((type) => (
          <QuickActionLink key={type} type={type} dashboard={dashboard} priority="primary" />
        ))}
      </div>

      <details className="group sm:hidden">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-center rounded-lg border border-border bg-card/70 text-sm font-black text-foreground marker:hidden">
          More
        </summary>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {secondaryQuickActions.map((type) => (
            <QuickActionLink key={type} type={type} dashboard={dashboard} priority="secondary" />
          ))}
        </div>
      </details>

      <div className="hidden gap-2 overflow-x-auto sm:flex">
        {secondaryQuickActions.map((type) => (
          <QuickActionLink key={type} type={type} dashboard={dashboard} priority="secondary" />
        ))}
      </div>
    </section>
  );
}

function QuickActionLink({
  type,
  dashboard,
  priority
}: {
  type: ActivityTypeName;
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
          ? "rounded-lg border border-border bg-card/80 p-2 text-center shadow-soft transition hover:border-primary/35 hover:bg-card"
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
        <ActivityArtwork type={type} size={primary ? "xl" : "lg"} />
        <p className={`${primary ? "text-sm" : "text-[11px]"} font-black leading-tight text-muted-foreground`}>
          {quickActionLabel(type)}
        </p>
        {active ? (
          <span className="rounded-full bg-primary/16 px-2 py-0.5 text-[10px] font-black leading-none text-primary">Active</span>
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

function DailySummary({
  summary,
  babyId,
  selectedDate,
  selectedType
}: {
  summary: DashboardWithBaby["dailySummary"];
  babyId: string;
  selectedDate: string;
  selectedType?: DailySummaryActivityType;
}) {
  type SummaryItemData = {
    key: DailySummaryActivityType;
    value: string;
    label: string;
  };
  const candidates: Array<SummaryItemData | null> = [
    summary.sleep.count
      ? {
          key: "sleep",
          value: formatDuration(summary.sleep.seconds) || "0 min",
          label: "Total Sleep"
        }
      : null,
    summary.feeding.count
      ? {
          key: "feeding",
          value: String(summary.feeding.count),
          label: summary.feeding.amount ? `${summary.feeding.amount.toFixed(1)} ${summary.feeding.unit}` : "Feeds"
        }
      : null,
    summary.diaper.count
      ? {
          key: "diaper",
          value: String(summary.diaper.count),
          label: diaperSummaryLabel(summary.diaper)
        }
      : null,
    summary.bath.count
      ? {
          key: "bath",
          value: String(summary.bath.count),
          label: summary.bath.count === 1 ? "Bath" : "Baths"
        }
      : null,
    summary.pumping.count
      ? {
          key: "pumping",
          value: summary.pumping.amount ? `${summary.pumping.amount.toFixed(1)} ${summary.pumping.unit}` : String(summary.pumping.count),
          label: summary.pumping.amount ? "Pumped" : "Pump"
        }
      : null,
    summary.milestone.count
      ? {
          key: "milestone",
          value: String(summary.milestone.count),
          label: summary.milestone.count === 1 ? "Milestone" : "Milestones"
        }
      : null,
    summary.medicine.count
      ? {
          key: "medicine",
          value: String(summary.medicine.count),
          label: "Medicine"
        }
      : null,
    summary.supplement.count
      ? {
          key: "supplement",
          value: String(summary.supplement.count),
          label: summary.supplement.count === 1 ? "Supplement" : "Supplements"
        }
      : null,
    summary.vaccine.count
      ? {
          key: "vaccine",
          value: String(summary.vaccine.count),
          label: summary.vaccine.count === 1 ? "Vaccine" : "Vaccines"
        }
      : null,
    summary.play.count
      ? {
          key: "play",
          value: summary.play.seconds ? formatDuration(summary.play.seconds) || "0 min" : String(summary.play.count),
          label: summary.play.seconds ? "Play Time" : "Play"
        }
      : null
  ];
  const items = candidates.filter((item): item is SummaryItemData => item !== null);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-black">Daily Summary</h2>
      {items.length ? (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-2">
          {items.map((item) => (
            <SummaryItem
              key={item.key}
              href={dailySummaryFilterHref(babyId, selectedDate, item.key, selectedType)}
              type={item.key}
              value={item.value}
              label={item.label}
              selected={selectedType === item.key}
            />
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

function SummaryItem({
  href,
  type,
  value,
  label,
  selected
}: {
  href: string;
  type: DailySummaryActivityType;
  value: string;
  label: string;
  selected: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "true" : undefined}
      className={`flex min-h-14 min-w-0 items-center gap-2 rounded-md border p-2 transition sm:min-w-32 sm:px-3 ${
        selected
          ? "border-primary/60 bg-primary/20 ring-1 ring-primary/30"
          : "border-border bg-card/60 hover:border-primary/40 hover:bg-muted"
      }`}
    >
      <ActivityArtwork type={type} size="xs" />
      <div className="min-w-0">
        <p className="truncate text-sm font-black leading-none sm:text-base">{value}</p>
        <p className="truncate text-xs font-semibold text-muted-foreground">{label}</p>
      </div>
    </Link>
  );
}

function dailySummaryFilterHref(
  babyId: string,
  date: string,
  type: DailySummaryActivityType,
  selectedType?: DailySummaryActivityType
) {
  const params = new URLSearchParams({ babyId, date });
  if (selectedType !== type) params.set("summaryType", type);
  return `/app?${params.toString()}`;
}

function dashboardReturnTo(babyId: string, date: string, selectedType?: DailySummaryActivityType) {
  const params = new URLSearchParams({ babyId, date });
  if (selectedType) params.set("summaryType", selectedType);
  return `/app?${params.toString()}`;
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
                  replace
                  key={activity.id}
                  prefetch={false}
                  href={activityDetailHref(activity.id, returnTo)}
                  className="relative block rounded-md border border-border bg-background/45 p-3 hover:bg-muted"
                >
                  <ActivityArtwork type={type} size="xs" className="absolute -left-[41px] top-2 ring-4 ring-background" />
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
