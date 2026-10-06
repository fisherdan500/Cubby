"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { formatDuration } from "@/lib/activity-format";
import { historyHref } from "@/lib/history-pagination";
import { addDaysToDateKey, formatCalendarDate } from "@/lib/timezone";
import type { TrendPoint, Trends } from "@/server/services/trends";

type TrendsTabProps = {
  babyId: string;
  babyName: string;
  trends: Trends;
  periods: Array<{ label: string; href: string; current: boolean }>;
};

type Measure = {
  key: "sleep" | "daytimeSleep" | "nighttimeSleep" | "feeds" | "volume" | "diapers" | "wetDiapers" | "dirtyDiapers";
  type: "sleep" | "feeding" | "diaper";
  title: string;
  note?: string;
  format: (value: number) => string;
};

/**
 * Sleep is the longest story and leads; volume follows feeds because it answers the same question in
 * more detail, for the part of the history where it can be answered at all.
 */
const measures: Measure[] = [
  { key: "sleep", type: "sleep", title: "Total sleep per day", format: (value) => formatDuration(Math.round(value)) || "0 min" },
  { key: "daytimeSleep", type: "sleep", title: "Daytime sleep per day (7 AM–7 PM)", format: (value) => formatDuration(Math.round(value)) || "0 min" },
  { key: "nighttimeSleep", type: "sleep", title: "Nighttime sleep per day (7 PM–7 AM)", format: (value) => formatDuration(Math.round(value)) || "0 min" },
  { key: "feeds", type: "feeding", title: "Feeds per day", format: (value) => value.toFixed(1) },
  {
    key: "volume",
    type: "feeding",
    title: "Bottle and formula per day",
    note: "Only days where every bottle and formula feed had its amount written down, in ounces or millilitres. Breastfeeds carry no amount, so weeks of mostly breastfeeding are left out.",
    format: (value) => `${value.toFixed(1)} oz`
  },
  { key: "diapers", type: "diaper", title: "Diapers per day", format: (value) => value.toFixed(1) },
  { key: "wetDiapers", type: "diaper", title: "Wet diapers per day", format: (value) => value.toFixed(1) },
  { key: "dirtyDiapers", type: "diaper", title: "Dirty diapers per day", format: (value) => value.toFixed(1) }
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
export function TrendsTab({ babyId, babyName, trends, periods }: TrendsTabProps) {
  const available = measures.filter((measure) => trends[measure.key].points.length > 0);
  const hasValues = available.some((measure) => trends[measure.key].points.some((point) => point.value !== null));

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

      {!trends.anyData || !hasValues ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            Not enough logged yet to show a trend for {babyName}. A few weeks of entries will fill this in.
          </p>
        </Card>
      ) : null}
      {available.length ? (
        <>
          <p className="text-sm text-muted-foreground">
            Each week, per day logged. A week with too little logged is left blank rather than drawn low.
          </p>
          {available.map((measure) => (
            <TrendPanel key={measure.key} babyId={babyId} measure={measure} points={trends[measure.key].points} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function TrendPanel({ babyId, measure, points }: { babyId: string; measure: Measure; points: TrendPoint[] }) {
  const selectorId = useId();
  const known = points.filter((point) => point.value !== null);
  const defaultPoint = known.at(-1) ?? points.at(-1);
  const [selectedKey, setSelectedKey] = useState(defaultPoint?.weekKey);
  const selected = points.find((point) => point.weekKey === selectedKey) ?? defaultPoint;
  if (selectedKey !== selected?.weekKey) setSelectedKey(selected?.weekKey);
  const values = known.map((point) => point.value as number);
  const high = known.length ? Math.max(...values) : 0;
  // A floor of zero keeps the shape honest: starting the axis at the lowest week would magnify a
  // small change into a cliff.
  const top = high > 0 ? high * 1.15 : 1;
  const counted = points.reduce((total, point) => total + point.daysCounted, 0);
  const logged = points.reduce((total, point) => total + point.daysLogged, 0);
  // Days that were logged but whose figure could not be known. Without this the caption reports
  // only the days that worked, which reads as full coverage of a week partly set aside.
  const unknown = points.reduce((total, point) => total + point.daysUnknown, 0);
  const unknownReason = measure.type === "sleep"
    ? "sleep that could not be allocated to this window"
    : measure.type === "diaper" ? "a diaper with no recorded kind" : "a bottle with no usable amount";

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

  const change = recentChange(measure, known);

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
        {known.length ? `${measure.format(high)} highest · ` : ""}{counted} of {logged} days
        {unknown > 0 ? ` · ${unknown} ${unknown === 1 ? "day" : "days"} had ${unknownReason}` : ""}
      </p>
      <div className="min-w-0 space-y-2 pt-3">
        <label htmlFor={selectorId} className="block text-sm font-semibold">{measure.title}: week</label>
        <Select id={selectorId} value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
          {points.map((point) => <option key={point.weekKey} value={point.weekKey}>{weekRange(point.weekKey)}</option>)}
        </Select>
      </div>
      {selected ? (
        <section aria-label={`${measure.title}: selected week`} aria-live="polite" className="space-y-1 pt-2 text-sm">
          <p>{weekRange(selected.weekKey)}</p>
          <p className="tabular font-semibold">{selected.value === null ? "Not enough logged" : measure.format(selected.value)}</p>
          <p className="tabular text-muted-foreground">
            {selected.daysCounted} {selected.daysCounted === 1 ? "day" : "days"} counted · {selected.daysLogged} {selected.daysLogged === 1 ? "day" : "days"} logged
            {selected.daysUnknown > 0 ? ` · ${selected.daysUnknown} ${selected.daysUnknown === 1 ? "day" : "days"} unknown` : ""}
          </p>
          {selected.value === null ? <p className="text-muted-foreground">A weekly value is unavailable for the logged data.</p> : null}
          {selected.daysUnknown > 0 ? <p className="text-muted-foreground">Unknown days had {unknownReason}.</p> : null}
          <p className="text-xs text-muted-foreground">Full Log shows records in or overlapping this week; some days may be excluded from the weekly value.</p>
          <Link
            href={historyHref({ babyId, type: measure.type, week: selected.weekKey })}
            className="inline-flex min-h-11 max-w-full items-center py-2 font-semibold text-primary underline underline-offset-4"
          >
            View {measure.type} records in this week
          </Link>
        </section>
      ) : null}
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

function recentChange(measure: Measure, known: TrendPoint[]) {
  const earlier = known[known.length - 2];
  const recent = known[known.length - 1];
  if (!earlier || !recent || earlier.value === null || recent.value === null) return null;

  const difference = recent.value - earlier.value;
  const direction = measure.type === "sleep"
    ? difference > 0 ? "longer" : "shorter"
    : difference > 0 ? "more" : "fewer";
  const amount = measure.key === "volume" ? Math.abs(difference).toFixed(1) : measure.format(Math.abs(difference));
  const unit = measure.key === "volume" ? " ounces" : "";
  const threshold = measure.type === "sleep" ? 60 : 0.05;
  const change = Math.abs(difference) < threshold
    ? "No change per logged day."
    : `${amount} ${direction}${unit} per logged day.`;
  return `${measure.format(earlier.value)} in ${weekRange(earlier.weekKey)} → ${measure.format(recent.value)} in ${weekRange(recent.weekKey)}: ${change}`;
}

function weekRange(weekKey: string) {
  return `${formatCalendarDate(weekKey)} – ${formatCalendarDate(addDaysToDateKey(weekKey, 6))}`;
}
