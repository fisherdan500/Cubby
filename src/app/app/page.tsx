import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ActivityArtwork } from "@/components/activity-artwork";
import { ActivityListRow, type ActivityListItem } from "@/components/activity-list-row";
import { DashboardWarnings } from "@/components/dashboard/dashboard-warnings";
import { DayPickerHeading } from "@/components/dashboard/day-picker-heading";
import { RunningTimerRow, RunningTimerTile } from "@/components/dashboard/running-timer";
import { ZeroActiveBabies } from "@/components/dashboard/zero-active-babies";
import { Button } from "@/components/ui/button";
import {
  activityLabels,
  filterActivitiesBySummaryType,
  isDailySummaryActivityType,
  type ActivityTypeName,
  type DailySummaryActivityType
} from "@/domain/activity";
import { hasPermission } from "@/domain/roles";
import { parseUnitPreferences } from "@/domain/unit-preferences";
import type { VolumeUnit } from "@/domain/units";
import { formatDuration, formatTimeSince } from "@/lib/activity-format";
import { timersWithoutTile } from "@/lib/dashboard-timers";
import { formatInstant } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { getDashboardPageData } from "@/server/services/dashboard";

const quickActions: ActivityTypeName[] = [
  "sleep", "feeding", "diaper", "note", "bath", "pumping", "measurement",
  "milestone", "medicine", "play", "mood", "supplement", "vaccine", "milk_inventory"
];

const primaryQuickActionTypes = new Set<ActivityTypeName>(["sleep", "feeding", "diaper"]);
const primaryQuickActions = quickActions.filter((type) => primaryQuickActionTypes.has(type));
const secondaryQuickActions = quickActions.filter((type) => !primaryQuickActionTypes.has(type));

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
        <ZeroActiveBabies canManageBabies={hasPermission(dashboard.home.role, "baby.manage")} />
      ) : (
        <div className="space-y-5">
          <DayStrip dashboard={currentDashboard} />
          {/* The day switcher sits with the summary and log it controls, below the actions, rather
              than above the quick-action tiles. */}
          <DateNavigator babyId={baby.id} selectedDate={currentDashboard.selectedDate} />
          <DailySummary
            summary={currentDashboard.dailySummary}
            babyId={baby.id}
            selectedDate={currentDashboard.selectedDate.key}
            selectedType={selectedSummaryType}
          />
          <DashboardWarnings warnings={currentDashboard.warnings} />

          {/* The "Daily log" heading and the Undo last button are hidden for now at the User's request:
              the heading repeated what the screen already says, and Undo last risked more harm than
              good in its prominent position. UndoLastButton itself is kept for a later placement. */}
          <section aria-label="Daily log" className="space-y-3">
            {visibleActivities.length === 0 ? (
              <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No activity for this date.</p>
            ) : (
              <Timeline
                activities={visibleActivities}
                timeZone={currentDashboard.selectedDate.timezone}
                returnTo={dashboardReturnTo(baby.id, currentDashboard.selectedDate.key, selectedSummaryType)}
                volume={parseUnitPreferences(currentDashboard.home.household.settings?.unitPreferences).volume}
              />
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function DayStrip({ dashboard }: { dashboard: DashboardWithBaby }) {
  // One render clock for every indicator, so they all start from the same instant and the client's
  // first render matches the server's.
  const nowMs = Date.now();
  return (
    <section className="space-y-3 border-y border-border bg-surface/70 px-1 py-3 sm:px-2 sm:py-4">
      <div className="grid grid-cols-3 gap-2 sm:max-w-xl">
        {primaryQuickActions.map((type) => {
          // A running timer takes over its own tile rather than opening a second card further down
          // the screen: the thing you started and the thing you read is the same object. The tile is
          // an indicator only; stopping happens in the shell's timer bar or on the activity itself.
          const timer = dashboard.activeTimers.find((entry) => entry.type === type);
          return timer ? (
            <RunningTimerTile key={type} timer={timer} label={quickActionLabel(type)} nowMs={nowMs} />
          ) : (
            <QuickActionLink key={type} type={type} dashboard={dashboard} priority="primary" />
          );
        })}
      </div>

      {/* Every other running timer: the types with no tile of their own, and any second timer of a
          type that already has one. Without this a twin's feed, or a second nap, would be running
          with nothing on the screen to say so. */}
      {timersWithoutTile(dashboard.activeTimers, primaryQuickActionTypes).map((timer) => (
        <RunningTimerRow key={timer.id} timer={timer} nowMs={nowMs} />
      ))}

      <details className="group sm:hidden">
        {/* Still a full 44px target, but a quiet text control rather than a bordered button the
            same weight as the tiles above it. */}
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center rounded-lg text-sm font-black text-muted-foreground transition hover:bg-muted hover:text-foreground marker:hidden">
          More activities
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

type ActiveTimer = DashboardWithBaby["activeTimers"][number];

function QuickActionLink({
  type,
  dashboard,
  priority
}: {
  type: ActivityTypeName;
  dashboard: DashboardWithBaby;
  priority: "primary" | "secondary";
}) {
  const since = timeSince(type, dashboard);
  const active = dashboard.activeTimers.some((timer) => timer.type === type);
  const primary = priority === "primary";

  return (
    <Link
      href={activityLogHref(type, dashboard)}
      className={
        primary
          ? "rounded-lg border border-border bg-card/80 px-1 py-2 text-center shadow-soft transition hover:border-primary/35 hover:bg-card"
          : "min-w-0 rounded-lg p-1 text-center transition hover:bg-muted sm:min-w-20"
      }
    >
      <div className="flex flex-col items-center gap-1">
        <ActivityArtwork type={type} size="lg" />
        <p className={`${primary ? "text-sm" : "text-xs"} font-black leading-tight text-foreground`}>
          {quickActionLabel(type)}
        </p>
        {/* Time since the last one, as words under the name, so it reads as "Feed, 2h ago" rather
            than an unlabelled number floating above the tile. */}
        {primary ? (
          <p className="min-h-4 text-xs font-semibold leading-tight text-muted-foreground">
            {since ?? "None yet"}
          </p>
        ) : null}
        {active ? (
          <span className="rounded-full bg-primary/16 px-2 py-0.5 text-[11px] font-black leading-none text-primary">Active</span>
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
  // "Today" and "Yesterday" read faster than a date at 3am; anything older keeps the weekday so the
  // day is still identifiable without doing arithmetic.
  const relative = selectedDate.isToday || selectedDate.isYesterday;
  // Any other day shows its date once. The year only appears when it differs from this year's.
  const sameYear = selectedDate.key.slice(0, 4) === selectedDate.todayKey.slice(0, 4);
  const heading = selectedDate.isToday ? "Today" : selectedDate.isYesterday ? "Yesterday" : sameYear ? selectedDate.shortLabel : selectedDate.label;
  const showReturnToToday = !selectedDate.isToday;

  return (
    <nav className="flex items-center gap-1" aria-label="Choose a day">
      <Link
        href={`/app?babyId=${babyId}&date=${selectedDate.previous}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label="Previous day"
      >
        <ChevronLeft className="h-5 w-5" />
      </Link>
      {/* Tapping the day opens a calendar to jump anywhere. Today and Yesterday keep the date as a
          second line so the relative label never hides which day is open; other days show it once. */}
      <DayPickerHeading
        babyId={babyId}
        dateKey={selectedDate.key}
        maxDateKey={selectedDate.todayKey}
        heading={heading}
        subheading={relative ? selectedDate.shortLabel : undefined}
      />
      <Link
        href={`/app?babyId=${babyId}&date=${selectedDate.next}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label="Next day"
      >
        <ChevronRight className="h-5 w-5" />
      </Link>
      {showReturnToToday ? (
        <Link
          href={`/app?babyId=${babyId}&date=${selectedDate.todayKey}`}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-black text-primary transition hover:bg-muted"
        >
          Today
        </Link>
      ) : null}
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
        // One swipeable row rather than a grid of cards: the summary is a glance, and as a grid it
        // pushed the day's log below the first screen on a phone.
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
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
      className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 transition ${
        selected
          ? "border-primary/60 bg-primary/20 ring-1 ring-primary/30"
          : "border-border bg-card/60 hover:border-primary/40 hover:bg-muted"
      }`}
    >
      <ActivityArtwork type={type} size="xs" />
      <div className="min-w-0">
        <p className="whitespace-nowrap text-sm font-black leading-none">{value}</p>
        <p className="max-w-40 truncate text-[11px] font-semibold leading-tight text-muted-foreground">{label}</p>
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

function Timeline({ activities, timeZone, returnTo, volume }: { activities: ActivityListItem[]; timeZone: string; returnTo: string; volume: VolumeUnit }) {
  const groups = activities.reduce<Record<string, ActivityListItem[]>>((acc, activity) => {
    const label = periodLabel(activity.occurredAt, timeZone);
    acc[label] = acc[label] ?? [];
    acc[label].push(activity);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      {Object.entries(groups).map(([label, items]) => (
        <div key={label} className="space-y-1.5">
          {/* A quiet pill instead of a heading and a rail. The whitespace between groups carries the
              structure, so a busy day reads as a rhythm rather than a ledger. */}
          <p className="inline-flex rounded-full bg-muted px-2.5 py-0.5 text-xs font-black text-muted-foreground">
            {label}
          </p>
          <div className="space-y-1.5">
            {items.map((activity) => (
              <ActivityListRow key={activity.id} activity={activity} returnTo={returnTo} timeZone={timeZone} volume={volume} />
            ))}
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

function timeSince(type: ActivityTypeName, dashboard: DashboardData) {
  if (type === "sleep") return formatTimeSince(dashboard.lastSleep?.endedAt ?? dashboard.lastSleep?.occurredAt);
  if (type === "feeding") return formatTimeSince(dashboard.lastFeeding?.occurredAt);
  if (type === "diaper") return formatTimeSince(dashboard.lastDiaper?.occurredAt);
  return null;
}

function quickActionLabel(type: ActivityTypeName) {
  if (type === "feeding") return "Feed";
  if (type === "pumping") return "Pump";
  return activityLabels[type];
}
