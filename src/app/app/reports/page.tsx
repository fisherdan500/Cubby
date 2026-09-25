import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, Clock3, LineChart, Trophy } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { RoutineTab } from "@/components/reports/routine-tab";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { env } from "@/lib/env";
import { growthSeries, milestoneTimeline } from "@/lib/growth-history";
import { buildStatsSummary } from "@/lib/stats-summary";
import { addDaysToDateKey } from "@/lib/timezone";
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
  // Growth and Milestones read the whole history instead; the date range does not apply to them.
  const historyTab = tab === "growth" || tab === "milestones";
  const report = await getReports(user.id, { ...searchParams, babyId: selectedBabyId, compare: tab === "stats", history: historyTab });
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
          {historyTab ? null : (
          <>
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
          </>
          )}

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
          {tab === "milestones" && report.history ? <MilestonesTab history={report.history} babyName={report.baby.name} /> : null}
          {tab === "growth" && report.history ? <GrowthTab history={report.history} babyName={report.baby.name} /> : null}
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

type History = NonNullable<ReportData["history"]>;
type GrowthPoints = History["growth"]["weight"];

/** Every milestone, newest first, by month - a record kept for good, not a window onto one. */
function MilestonesTab({ history, babyName }: { history: History; babyName: string }) {
  const groups = milestoneTimeline(history.milestones, env.APP_TIMEZONE);
  if (!groups.length) {
    return <Card><p className="text-sm text-muted-foreground">No milestones logged for {babyName} yet.</p></Card>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Every milestone logged for {babyName}, newest first.</p>
      {groups.map((group) => (
        <Card key={group.month} className="space-y-2">
          <h2 className="text-base font-semibold">{group.month}</h2>
          <ul className="divide-y divide-border">
            {group.items.map((item, index) => (
              <li key={`${item.title}-${index}`} className="py-2.5">
                <p className="font-semibold">{item.title}</p>
                <p className="text-xs text-muted-foreground">{[item.category, item.date, item.age].filter(Boolean).join(" · ")}</p>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/** Each measure leads with its latest value and how it changed; babies are measured weeks apart. */
function GrowthTab({ history, babyName }: { history: History; babyName: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Every measurement logged for {babyName}.</p>
      <Measure title="Weight" points={history.growth.weight} />
      <Measure title="Length/Height" points={history.growth.length} />
      <Measure title="Head Circumference" points={history.growth.head} />
      <p className="text-center text-xs text-muted-foreground">
        Percentiles are not shown until a household imports original CDC/WHO reference data.
      </p>
    </div>
  );
}

function Measure({ title, points }: { title: string; points: GrowthPoints }) {
  const series = growthSeries(points);
  if (series === null) {
    return (
      <section>
        <Card className="space-y-3">
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">Unavailable because one or more saved measurements use an unsupported unit.</p>
        </Card>
      </section>
    );
  }
  return (
    <section>
      <Card className="space-y-3">
        <h2 className="font-semibold">{title}</h2>
        {series.latest ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="tabular font-editorial text-3xl font-bold">{series.latest.value}</p>
              <p className="text-sm text-muted-foreground">
                {[series.latest.date, series.latest.age].filter(Boolean).join(" · ")}
                {series.sinceLast ? ` · ${series.sinceLast.change} since ${series.sinceLast.since}` : ""}
              </p>
            </div>
            {points && points.length > 1 ? <GrowthChart points={points} /> : null}
            <ul className="divide-y divide-border">
              {series.entries.map((entry, index) => (
                <li key={`${entry.date}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto_4.5rem] items-baseline gap-3 py-2 text-sm">
                  <span className="text-muted-foreground">{entry.date}</span>
                  <span className="text-xs text-muted-foreground">{entry.age ?? ""}</span>
                  <span className="tabular font-semibold">{entry.value}</span>
                  <span className="tabular text-right text-xs text-muted-foreground">{entry.change ?? ""}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No measurements logged yet.</p>
        )}
      </Card>
    </section>
  );
}

/** Spaced by date, so a long gap between measurements looks like one. Every point is listed as text. */
function GrowthChart({ points }: { points: NonNullable<GrowthPoints> }) {
  const width = 720;
  const height = 180;
  const ordered = [...points].sort((left, right) => left.date.localeCompare(right.date));
  const times = ordered.map((point) => Date.parse(`${point.date}T00:00:00Z`));
  const values = ordered.map((point) => point.value);
  const [first, last] = [Math.min(...times), Math.max(...times)];
  const [min, max] = [Math.min(...values), Math.max(...values)];
  const x = (time: number) => (last === first ? width / 2 : 20 + ((time - first) / (last - first)) * (width - 40));
  const y = (value: number) => height - ((value - min) / Math.max(max - min, 0.0001)) * (height - 40) - 20;
  const d = ordered.map((point, index) => `${index === 0 ? "M" : "L"} ${x(times[index]).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="h-44 w-full rounded-md bg-muted">
      <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="4" />
      {ordered.map((point, index) => (
        <circle key={`${point.date}-${index}`} cx={x(times[index])} cy={y(point.value)} r="5" fill="hsl(var(--accent))" />
      ))}
    </svg>
  );
}
