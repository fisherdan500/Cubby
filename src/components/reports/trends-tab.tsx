"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { formatDuration } from "@/lib/activity-format";
import type { TrendPoint, Trends } from "@/server/services/trends";

type TrendsTabProps = {
  babyName: string;
  trends: Trends;
  periods: Array<{ label: string; href: string; current: boolean }>;
};

type Measure = {
  key: "sleep" | "feeds" | "volume" | "diapers";
  title: string;
  note?: string;
  format: (value: number) => string;
};

/**
 * Sleep is the longest story and leads; volume follows feeds because it answers the same question in
 * more detail, for the part of the history where it can be answered at all.
 */
const measures: Measure[] = [
  { key: "sleep", title: "Total sleep per day", format: (value) => formatDuration(Math.round(value)) || "0 min" },
  { key: "feeds", title: "Feeds per day", format: (value) => value.toFixed(1) },
  {
    key: "volume",
    title: "Bottle and formula per day",
    note: "Only days where every bottle and formula feed had its amount written down, in ounces or millilitres. Breastfeeds carry no amount, so weeks of mostly breastfeeding are left out.",
    format: (value) => `${value.toFixed(1)} oz`
  },
  { key: "diapers", title: "Diapers per day", format: (value) => value.toFixed(1) }
];

const CHART_W = 720;
const CHART_H = 132;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 18;

/**
 * How the baby's week-by-week totals have moved. The Routine tab says what a usual day looks like
 * now; this says what has been changing underneath it.
 *
 * A week nobody logged enough of is drawn as a break in the line rather than a low point, and every
 * panel says how many days its figures rest on. A chart that quietly averages a day somebody forgot
 * to log is worse than no chart, because it looks like news.
 */
export function TrendsTab({ babyName, trends, periods }: TrendsTabProps) {
  const drawable = measures.filter((measure) => trends[measure.key].points.some((point) => point.value !== null));

  return (
    <div className="space-y-4">
      {periods.length ? (
        <nav aria-label="Trend period" className="flex flex-wrap gap-2 print:hidden">
          {periods.map((period) => (
            <Link
              key={period.label}
              href={period.href}
              aria-current={period.current ? "true" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${
                period.current
                  ? "bg-primary text-primary-foreground"
                  : "border border-control bg-card text-foreground hover:bg-muted"
              }`}
            >
              {period.label}
            </Link>
          ))}
        </nav>
      ) : null}

      {!trends.anyData || !drawable.length ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            Not enough logged yet to show a trend for {babyName}. A few weeks of entries will fill this in.
          </p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Each week, per day logged. A week with too little logged is left blank rather than drawn low.
          </p>
          {drawable.map((measure) => (
            <TrendPanel key={measure.key} measure={measure} points={trends[measure.key].points} />
          ))}
        </>
      )}
    </div>
  );
}

function TrendPanel({ measure, points }: { measure: Measure; points: TrendPoint[] }) {
  const known = points.filter((point) => point.value !== null);
  const values = known.map((point) => point.value as number);
  const high = Math.max(...values);
  // A floor of zero keeps the shape honest: starting the axis at the lowest week would magnify a
  // small change into a cliff.
  const top = high > 0 ? high * 1.15 : 1;
  const counted = points.reduce((total, point) => total + point.daysCounted, 0);
  const logged = points.reduce((total, point) => total + point.daysLogged, 0);
  // Days that were logged but whose figure could not be known. Without this the caption reports
  // only the days that worked, which reads as full coverage of a week partly set aside.
  const unknown = points.reduce((total, point) => total + point.daysUnknown, 0);

  // A single week sits in the middle rather than hard against the left edge, matching the growth
  // chart: pinned left it reads as the truncated start of a series that is not there.
  const x = (index: number) =>
    points.length === 1 ? CHART_W / 2 : PAD_L + ((CHART_W - PAD_L - PAD_R) * index) / (points.length - 1);
  const y = (value: number) => PAD_T + (CHART_H - PAD_T - PAD_B) * (1 - value / top);

  // One path per unbroken run, so a gap stays a gap instead of becoming a straight line across it.
  // A run of a single point still gets a path: with a gap either side it is the only mark saying
  // that week was measured, and dropping it would leave the panel looking unlogged.
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: x(index), y: y(point.value) });
  });
  if (run.length) runs.push(run);

  const first = known[0];
  const last = known[known.length - 1];
  const change =
    first && last && first !== last
      ? `${measure.format(first.value as number)} in ${monthOf(first.weekKey)} → ${measure.format(last.value as number)} in ${monthOf(last.weekKey)}`
      : null;

  return (
    <Card className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">{measure.title}</h3>
        {change ? <p className="tabular text-sm text-muted-foreground">{change}</p> : null}
      </div>
      {measure.note ? <p className="text-xs text-muted-foreground">{measure.note}</p> : null}
      {/* Hidden from assistive tech because every figure is listed as text below, which is how the
          growth charts on this page already work. */}
      <svg aria-hidden="true" viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-auto w-full">
        <line x1={PAD_L} y1={y(0)} x2={CHART_W - PAD_R} y2={y(0)} className="stroke-border" strokeWidth="1" />
        <line x1={PAD_L} y1={y(top)} x2={CHART_W - PAD_R} y2={y(top)} className="stroke-border" strokeWidth="1" strokeDasharray="3 4" />
        {points.map((point, index) =>
          point.value === null ? (
            <rect key={point.weekKey} x={x(index) - 4} y={PAD_T} width="8" height={CHART_H - PAD_T - PAD_B} className="fill-muted" />
          ) : null
        )}
        {runs.map((segment) => (
          <path
            key={`${segment[0].x}-${segment[segment.length - 1].x}`}
            data-trend-line=""
            d={segment.map((node, index) => `${index === 0 ? "M" : "L"} ${node.x.toFixed(1)} ${node.y.toFixed(1)}`).join(" ")}
            fill="none"
            className="stroke-primary"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {points.map((point, index) =>
          point.value === null ? null : (
            <circle key={point.weekKey} cx={x(index)} cy={y(point.value)} r="2.6" className="fill-primary" />
          )
        )}
      </svg>
      <p className="tabular text-xs text-muted-foreground">
        {measure.format(top === 1 && !high ? 0 : high)} highest · {counted} of {logged} days
        {unknown > 0 ? ` · ${unknown} ${unknown === 1 ? "day" : "days"} had a bottle with no amount` : ""}
      </p>
      <ul data-trend-values="" className="sr-only">
        {points.map((point) => (
          <li key={point.weekKey}>
            {`Week of ${point.weekKey}: ${point.value === null ? "not enough logged" : measure.format(point.value)}`}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function monthOf(weekKey: string) {
  const [year, month, day] = weekKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}
