"use client";

import Link from "next/link";
import { Printer } from "lucide-react";
import { ActivityArtwork } from "@/components/activity-artwork";
import { PlannedSchedulePanel } from "@/components/reports/planned-schedule";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ROUTINE_MIN_DAYS, type RoutineSlot } from "@/lib/observed-routine";
import { printSection } from "@/lib/print-section";
import type { PlannedScheduleView } from "@/server/services/planned-schedule";
import type { RoutineTimeline } from "@/server/services/reports";

type RoutineTabProps = {
  babyName: string;
  routine: RoutineTimeline;
  // How many recent days, up to today, the routine is worked out from.
  periods: Array<{ label: string; href: string; current: boolean }>;
  schedule?: PlannedScheduleView | null;
};

/**
 * What the baby's day has actually looked like: a line summing it up, then the day in order - the list
 * someone could follow if they were looking after the baby. The summary carries only what the list
 * cannot (how long the night is, how steady the naps are, how often feeds come), so the list starts
 * near the top of a phone's screen. It is observed, never a plan, and says so wherever it could be
 * mistaken for one, printed pages included.
 */
export function RoutineTab({ babyName, routine, periods, schedule }: RoutineTabProps) {
  const range = `${formatDateKey(routine.startKey)} to ${formatDateKey(routine.endKey)}`;
  const summary = routineSummary(routine);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <nav aria-label="Routine period" className="flex flex-wrap gap-2">
          {periods.map((period) => (
            <Link
              key={period.label}
              href={period.href}
              aria-current={period.current ? "true" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${
                period.current ? "bg-primary text-primary-foreground" : "border border-control bg-card text-foreground hover:bg-muted"
              }`}
            >
              {period.label}
            </Link>
          ))}
        </nav>
        {routine.enoughData ? (
          <Button type="button" variant="secondary" onClick={() => printSection("routine")}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print routine
          </Button>
        ) : null}
      </div>

      <div data-print-section="routine" className="space-y-5">
      {/* On screen the tab already says what this is; on paper, away from the app, it has to. */}
      <header className="hidden space-y-1 print:block">
        <h2 className="font-editorial text-2xl font-bold">{babyName}&apos;s routine</h2>
        <p className="text-sm">
          Worked out from what was logged, {range}. This is what happened, not a plan: check the latest log before relying on it.
        </p>
      </header>

      {!routine.enoughData ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            Not enough logged yet to see a routine. It appears once sleep or feeds have been logged on at least {ROUTINE_MIN_DAYS} days
            {routine.daysWithData ? ` (${routine.daysWithData} of the last ${routine.windowDays} so far)` : ""}.
          </p>
        </Card>
      ) : (
        <>
          <section>
          <Card className="space-y-3 print:border-foreground/40 print:shadow-none">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Typical day</h2>
              <p className="text-xs font-semibold text-muted-foreground print:hidden">From {range}</p>
            </div>
            {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
            <ol aria-label="Typical day" className="divide-y divide-border">
              {routine.timeline.map((entry) => (
                <li key={entry.id} className="grid grid-cols-[4.75rem_2rem_minmax(0,1fr)_auto] items-center gap-3 py-2.5 break-inside-avoid">
                  <span className="tabular text-sm font-bold text-primary print:text-foreground">{entry.slot.time}</span>
                  <ActivityArtwork type={entry.activityType} size="xs" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{entry.label}</span>
                    {entry.slot.duration && entry.kind !== "bedtime" && entry.kind !== "wake" ? (
                      <span className="block text-xs text-muted-foreground">for about {entry.slot.duration}</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{spreadText(entry.slot)}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              Times are the usual time across the days that followed the usual pattern; ± shows how much they typically moved.
            </p>
          </Card>
          </section>
        </>
      )}
      </div>

      {schedule ? <PlannedSchedulePanel babyName={babyName} schedule={schedule} routine={routine} /> : null}
    </div>
  );
}

/**
 * "Night about 11h 15m · 2 naps a day on 6 of 7 days · about 5 feeds by day, roughly every 3h, none at
 * night". Wake-up and bedtime are left to the list, which shows them with their times.
 */
function routineSummary({ night, naps, feeds }: RoutineTimeline) {
  const napText = !naps
    ? null
    : naps.slots.length || naps.minCount === naps.maxCount
      ? `${naps.usualCount} ${naps.usualCount === 1 ? "nap" : "naps"} a day${naps.slots.length ? ` on ${naps.daysWithUsualCount} of ${naps.daysCounted} days` : ""}`
      : `${naps.minCount} to ${naps.maxCount} naps a day, too varied to list times`;
  const feedText = feeds
    ? [
        `about ${feeds.usualCount} feeds by day`,
        feeds.interval ? `roughly every ${feeds.interval}` : null,
        feeds.nightFeeds ? `${formatCount(feeds.nightFeeds.perNight)} at night` : null
      ].filter(Boolean).join(", ")
    : null;
  return [night ? `Night about ${night.duration}` : null, napText, feedText].filter(Boolean).join(" · ");
}

function spreadText(slot: RoutineSlot) {
  return slot.spreadMinutes < 5 ? "" : `± ${slot.spreadMinutes} min`;
}

function formatCount(value: number) {
  if (value === 0) return "none";
  return `about ${Number.isInteger(value) ? value : value.toFixed(1)}`;
}

function formatDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}
