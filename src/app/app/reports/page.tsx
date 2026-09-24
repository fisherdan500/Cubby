import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, Clock3, LineChart, Trophy } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { RoutineTab } from "@/components/reports/routine-tab";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { env } from "@/lib/env";
import { buildStatsSummary } from "@/lib/stats-summary";
import { addDaysToDateKey, formatInstantDate } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getPlannedSchedule } from "@/server/services/planned-schedule";
import { getReports } from "@/server/services/reports";

// Activity (how often each type was logged) and Heatmaps were retired: the first described the
// logging more than the baby, and Routine now shows when things happen far more readably. An old
// link to either opens Routine.
const tabs = [
  ["routine", "Routine", Clock3],
  ["stats", "Stats", BarChart3],
  ["growth", "Growth", LineChart],
  ["milestones", "Milestones", Trophy]
] as const;

const quickPeriods = [7, 14, 30] as const;

export default async function ReportsPage({
  searchParams
}: {
  searchParams: { babyId?: string; start?: string; end?: string; tab?: string; routineWindow?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const tab = searchParams.tab && tabs.some(([value]) => value === searchParams.tab) ? searchParams.tab : "routine";
  // Only Stats compares with the period before, so only Stats pays for reading it.
  const report = await getReports(user.id, { ...searchParams, babyId: selectedBabyId, compare: tab === "stats" });
  if (!report?.home) redirect("/onboarding");
  // The plan sits beside the observed routine, so it is only read when that tab is open.
  const schedule = tab === "routine" && report.baby ? await getPlannedSchedule(report.baby.id) : null;
  const reportHref = (next: { tab?: string; routineWindow?: string; start?: string; end?: string }) => {
    const params = new URLSearchParams();
    if (report.baby?.id) params.set("babyId", report.baby.id);
    params.set("start", next.start ?? report.startKey);
    params.set("end", next.end ?? report.endKey);
    params.set("tab", next.tab ?? tab);
    params.set("routineWindow", next.routineWindow ?? report.routine.window);
    return `/app/reports?${params.toString()}`;
  };

  return (
    <AppShell title="Reports" userName={user.name} babySelector={babySelector}>
      {!report.baby || !report.stats ? (
        <Card>Add a baby before viewing reports.</Card>
      ) : (
        <div className="space-y-5">
          <nav aria-label="Report period" className="flex flex-wrap gap-2 print:hidden">
            {quickPeriods.map((days) => {
              const start = addDaysToDateKey(report.todayKey, -(days - 1));
              const current = report.startKey === start && report.endKey === report.todayKey;
              return (
                <Link
                  key={days}
                  href={reportHref({ start, end: report.todayKey })}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${
                    current ? "bg-primary text-primary-foreground" : "border border-control bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  {days} days
                </Link>
              );
            })}
          </nav>

          <Card className="w-fit max-w-full print:hidden">
            <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
              <input name="babyId" type="hidden" value={report.baby.id} />
              <input name="tab" type="hidden" value={tab} />
              <input name="routineWindow" type="hidden" value={report.routine.window} />
              {/* A bare date input announces only "date"; these say which end of the range they set. */}
              <label htmlFor="report-start" className="sr-only">
                Report start date
              </label>
              <Input id="report-start" name="start" type="date" defaultValue={report.startKey} className="sm:w-48" />
              <label htmlFor="report-end" className="sr-only">
                Report end date
              </label>
              <Input id="report-end" name="end" type="date" defaultValue={report.endKey} className="sm:w-48" />
            </AutoSubmitForm>
          </Card>

          {/* Which report is open was carried by colour alone; aria-current says it too. */}
          <nav aria-label="Report views" className="flex gap-2 overflow-x-auto border-b border-border pb-2 print:hidden">
            {tabs.map(([value, label, Icon]) => (
              <Link
                key={value}
                href={reportHref({ tab: value })}
                aria-current={tab === value ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-md px-4 text-sm font-bold ${
                  tab === value ? "bg-muted text-primary" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </nav>

          {tab === "stats" ? <StatsTab stats={report.stats} previous={report.previous} /> : null}
          {tab === "milestones" ? <MilestonesTab stats={report.stats} /> : null}
          {tab === "growth" ? <GrowthTab stats={report.stats} /> : null}
          {tab === "routine" ? (
            <RoutineTab
              babyId={report.baby.id}
              babyName={report.baby.name}
              schedule={schedule}
              startKey={report.startKey}
              endKey={report.endKey}
              routine={report.routine}
            />
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

type ReportData = NonNullable<Awaited<ReturnType<typeof getReports>>>;

/**
 * Each area as per-day figures with how they moved against the period just before - the question a
 * parent brings here ("is she sleeping more than last week?") rather than raw totals to divide.
 */
function StatsTab({ stats, previous }: { stats: ReportData["stats"]; previous: ReportData["previous"] }) {
  if (!stats) return null;
  const summary = buildStatsSummary(stats, previous?.stats ?? null);
  if (!summary.sections.length) {
    return <Card><p className="text-sm text-muted-foreground">Nothing logged in this period yet.</p></Card>;
  }
  const comparing = Boolean(previous && previous.stats.daysWithEntries > 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Per day, over the {summary.daysWithEntries} {summary.daysWithEntries === 1 ? "day" : "days"} with entries
        {comparing && previous ? `, compared with ${formatDateKey(previous.startKey)} to ${formatDateKey(previous.endKey)}` : ""}.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {summary.sections.map((section) => (
          <Card key={section.title} className="space-y-2">
            <h2 className="text-base font-semibold">{section.title}</h2>
            <ul className="divide-y divide-border">
              {section.rows.map((row) => (
                <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-baseline gap-3 py-2.5">
                  <span className="text-sm font-semibold text-muted-foreground">{row.label}</span>
                  <span className="tabular font-editorial text-xl font-bold">{row.value}</span>
                  <span className="tabular text-right text-xs font-semibold text-muted-foreground">{row.change ?? ""}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

function formatDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function MilestonesTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  return (
    <Card className="space-y-3">
      {stats.milestones.length ? null : <p className="text-sm text-muted-foreground">No milestones in this range.</p>}
      {stats.milestones.map((milestone) => (
        <div key={`${milestone.title}-${milestone.date.toISOString()}`} className="rounded-md bg-muted p-3">
          <p className="font-semibold">{milestone.title}</p>
          <p className="text-sm text-muted-foreground">
            {milestone.category ?? "Milestone"} - {formatInstantDate(milestone.date, env.APP_TIMEZONE)}
          </p>
        </div>
      ))}
    </Card>
  );
}

function GrowthTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  return (
    <div className="space-y-4">
      <Trend title="Weight" points={stats.growth.weight} />
      <Trend title="Length/Height" points={stats.growth.length} />
      <Trend title="Head Circumference" points={stats.growth.head} />
      <p className="text-center text-xs text-muted-foreground">
        Percentiles are not shown until a household imports original CDC/WHO reference data.
      </p>
    </div>
  );
}

function Trend({
  title,
  points
}: {
  title: string;
  points: Array<{ date: string; ageMonths: number; value: number; unit: string }> | null;
}) {
  if (points === null) {
    return (
      <Card className="space-y-3">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">Unavailable because one or more saved measurements use an unsupported unit.</p>
      </Card>
    );
  }
  const width = 720;
  const height = 180;
  const values = points.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const d = points
    .map((point, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - ((point.value - min) / span) * (height - 20) - 10;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{title}</h2>
      {points.length ? (
        <>
          {/* Decorative: every plotted measurement is listed as text directly below. */}
          <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="h-52 w-full rounded-md bg-muted">
            <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="4" />
            {points.map((point, index) => {
              const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
              const y = height - ((point.value - min) / span) * (height - 20) - 10;
              return <circle key={`${point.date}-${index}`} cx={x} cy={y} r="5" fill="hsl(var(--accent))" />;
            })}
          </svg>
          <div className="grid gap-2 md:grid-cols-3">
            {points.map((point) => (
              <div key={`${point.date}-${point.value}`} className="rounded-md bg-muted p-3">
                <p className="font-semibold">
                  {point.value} {point.unit}
                </p>
                <p className="text-xs text-muted-foreground">
                  {point.ageMonths} months - {point.date}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No measurements in this range.</p>
      )}
    </Card>
  );
}
