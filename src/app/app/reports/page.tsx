import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, BarChart3, Clock3, Grid3X3, LineChart, Trophy } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Card } from "@/components/ui/card";
import { activityLabels, activityTypes, type ActivityTypeName } from "@/domain/activity";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getReports } from "@/server/services/reports";

const tabs = [
  ["stats", "Stats", BarChart3],
  ["milestones", "Milestones", Trophy],
  ["growth", "Growth Trends", LineChart],
  ["activity", "Activity", Activity],
  ["routine", "Routine", Clock3],
  ["heatmaps", "Heatmaps", Grid3X3]
] as const;

export default async function ReportsPage({
  searchParams
}: {
  searchParams: { babyId?: string; start?: string; end?: string; tab?: string; routineWindow?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const report = await getReports(user.id, { ...searchParams, babyId: selectedBabyId });
  if (!report?.home) redirect("/onboarding");
  const tab = searchParams.tab && tabs.some(([value]) => value === searchParams.tab) ? searchParams.tab : "stats";
  const reportHref = (next: { tab?: string; routineWindow?: string }) => {
    const params = new URLSearchParams();
    if (report.baby?.id) params.set("babyId", report.baby.id);
    params.set("start", report.startKey);
    params.set("end", report.endKey);
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
          <Card className="w-fit max-w-full">
            <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
              <input name="babyId" type="hidden" value={report.baby.id} />
              <input name="tab" type="hidden" value={tab} />
              <input name="routineWindow" type="hidden" value={report.routine.window} />
              <input name="start" type="date" defaultValue={report.startKey} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 sm:w-48" />
              <input name="end" type="date" defaultValue={report.endKey} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 sm:w-48" />
            </AutoSubmitForm>
          </Card>

          <div className="flex gap-2 overflow-x-auto border-b border-border pb-2">
            {tabs.map(([value, label, Icon]) => (
              <Link
                key={value}
                href={reportHref({ tab: value })}
                className={`inline-flex min-h-11 items-center gap-2 rounded-md px-4 text-sm font-bold ${
                  tab === value ? "bg-muted text-primary" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </div>

          {tab === "stats" ? <StatsTab stats={report.stats} /> : null}
          {tab === "milestones" ? <MilestonesTab stats={report.stats} /> : null}
          {tab === "growth" ? <GrowthTab stats={report.stats} /> : null}
          {tab === "activity" ? <ActivityTab stats={report.stats} /> : null}
          {tab === "routine" ? <RoutineTab report={report} /> : null}
          {tab === "heatmaps" ? <HeatmapTab stats={report.stats} /> : null}
        </div>
      )}
    </AppShell>
  );
}

function StatsTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  return (
    <div className="space-y-6">
      <ReportSection title="Sleep Statistics">
        <Metric label="Total sleep" value={stats.sleep.total} />
        <Metric label="Average sleep log" value={stats.sleep.average} />
        <Metric label="Naps" value={String(stats.sleep.naps)} />
        <Metric label="Night sleep" value={stats.sleep.night} />
      </ReportSection>
      <ReportSection title="Feeding Statistics">
        <Metric label="Bottle feeds" value={String(stats.feeding.bottleCount)} />
        <Metric label="Bottle average" value={`${stats.feeding.bottleAverage} oz`} />
        <Metric label="Breast feeds" value={String(stats.feeding.breastCount)} />
        <Metric label="Solids" value={String(stats.feeding.solidsCount)} />
      </ReportSection>
      <ReportSection title="Care Statistics">
        <Metric label="Wet diapers" value={String(stats.diaper.wet)} />
        <Metric label="Dirty diapers" value={String(stats.diaper.dirty)} />
        <Metric label="Pumped" value={`${stats.pumping.total} oz`} />
      </ReportSection>
    </div>
  );
}

function MilestonesTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  return (
    <Card className="space-y-3">
      {stats.milestones.length ? null : <p className="text-sm text-muted-foreground">No milestones in this range.</p>}
      {stats.milestones.map((milestone) => (
        <div key={`${milestone.title}-${milestone.date.toISOString()}`} className="rounded-md bg-muted p-3">
          <p className="font-black">{milestone.title}</p>
          <p className="text-sm text-muted-foreground">
            {milestone.category ?? "Milestone"} - {milestone.date.toLocaleDateString()}
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

function ActivityTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  const max = Math.max(1, ...Object.values(stats.byType));
  return (
    <Card className="space-y-3">
      {activityTypes.map((type) => (
        <div key={type} className="grid grid-cols-[150px_1fr_40px] items-center gap-3">
          <p className="text-sm font-bold">{activityLabels[type]}</p>
          <div className="h-3 rounded-full bg-muted">
            <div className="h-3 rounded-full bg-primary" style={{ width: `${(stats.byType[type] / max) * 100}%` }} />
          </div>
          <p className="text-right text-sm font-black">{stats.byType[type]}</p>
        </div>
      ))}
    </Card>
  );
}

function RoutineTab({ report }: { report: NonNullable<Awaited<ReturnType<typeof getReports>>> }) {
  if (!report.baby) return null;
  const routine = report.routine;
  return (
    <div className="space-y-5">
      <Card className="w-fit max-w-full">
        <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
          <input name="babyId" type="hidden" value={report.baby.id} />
          <input name="start" type="hidden" value={report.startKey} />
          <input name="end" type="hidden" value={report.endKey} />
          <input name="tab" type="hidden" value="routine" />
          <select
            name="routineWindow"
            defaultValue={routine.window}
            className="min-h-11 w-full rounded-lg border border-border bg-card px-3 sm:w-44"
          >
            <option value="1w">1 week</option>
            <option value="2w">2 weeks</option>
            <option value="1m">1 month</option>
          </select>
        </AutoSubmitForm>
      </Card>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Avg sleep time" value={routine.summary.averageSleepTime ?? "--"} />
        <Metric label="Avg sleep duration" value={routine.summary.averageSleepDuration} />
        <Metric label="Avg feed time" value={routine.summary.averageFeedTime ?? "--"} />
        <Metric label="Days included" value={`${routine.daysWithData}/${routine.windowDays}`} />
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-black">Typical Day</h2>
            <p className="text-sm text-muted-foreground">
              {routine.windowLabel} ending {routine.endKey}
            </p>
          </div>
          <p className="text-xs font-bold text-muted-foreground">
            {routine.summary.sleepSamples + routine.summary.feedSamples} samples
          </p>
        </div>

        {routine.rows.length ? (
          <div className="space-y-3">
            {routine.rows.map((row) => (
              <div key={`${row.type}-${row.index}`} className="grid grid-cols-[84px_1fr] gap-4 rounded-lg bg-muted p-3">
                <p className="text-sm font-black text-primary">{row.averageTime}</p>
                <div>
                  <p className="font-black">
                    {row.type === "sleep"
                      ? `Sleep around ${row.averageTime} for ${row.averageDuration}`
                      : `Feed around ${row.averageTime}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {row.sampleCount} {row.sampleCount === 1 ? "sample" : "samples"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sleep or feeding data in this routine window.</p>
        )}
      </Card>
    </div>
  );
}

function HeatmapTab({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof getReports>>>["stats"] }) {
  if (!stats) return null;
  const max = Math.max(1, ...stats.heatmap.map((item) => item.count));
  return (
    <Card className="overflow-x-auto">
      <div className="grid min-w-[760px] grid-cols-[80px_repeat(24,1fr)] gap-1 text-xs">
        <div />
        {Array.from({ length: 24 }, (_, hour) => (
          <div key={hour} className="text-center text-muted-foreground">
            {hour}
          </div>
        ))}
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, dayIndex) => (
          <>
            <div key={`${day}-label`} className="font-bold">
              {day}
            </div>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = stats.heatmap[dayIndex * 24 + hour].count;
              return (
                <div
                  key={`${day}-${hour}`}
                  className="h-7 rounded-sm border border-border"
                  style={{ backgroundColor: `hsl(174 65% ${14 + (value / max) * 42}%)` }}
                  title={`${day} ${hour}:00 - ${value}`}
                />
              );
            })}
          </>
        ))}
      </div>
    </Card>
  );
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <h2 className="text-base font-black">{title}</h2>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-3 md:grid-cols-4">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-2xl font-black">{value}</p>
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
    </Card>
  );
}

function Trend({ title, points }: { title: string; points: Array<{ date: string; ageMonths: number; value: number; unit: string }> }) {
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
      <h2 className="font-black">{title}</h2>
      {points.length ? (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full rounded-md bg-muted">
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
                <p className="font-black">
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
