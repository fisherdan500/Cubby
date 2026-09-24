"use client";

import { Printer } from "lucide-react";
import { ActivityArtwork } from "@/components/activity-artwork";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ROUTINE_MIN_DAYS, type RoutineSlot } from "@/lib/observed-routine";
import type { RoutineTimeline } from "@/server/services/reports";

type RoutineTabProps = {
  babyId: string;
  babyName: string;
  startKey: string;
  endKey: string;
  routine: RoutineTimeline;
};

/**
 * What the baby's day has actually looked like: the anchors first (waking, bedtime, how many naps and
 * feeds), then the day in order - the list someone could follow if they were looking after the baby.
 * It is observed, never a plan, and says so wherever it could be mistaken for one, printed pages
 * included.
 */
export function RoutineTab({ babyId, babyName, startKey, endKey, routine }: RoutineTabProps) {
  const range = `${formatDateKey(routine.startKey)} to ${formatDateKey(routine.endKey)}`;
  const { naps, feeds } = routine;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
          <input name="babyId" type="hidden" value={babyId} />
          <input name="start" type="hidden" value={startKey} />
          <input name="end" type="hidden" value={endKey} />
          <input name="tab" type="hidden" value="routine" />
          <label className="grid gap-1 text-xs font-bold text-muted-foreground">
            Based on the last
            <select
              name="routineWindow"
              defaultValue={routine.window}
              className="min-h-11 w-full rounded-lg border border-control bg-card px-3 text-sm text-foreground sm:w-44"
            >
              <option value="1w">1 week</option>
              <option value="2w">2 weeks</option>
              <option value="1m">1 month</option>
            </select>
          </label>
        </AutoSubmitForm>
        {routine.enoughData ? (
          <Button type="button" variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print
          </Button>
        ) : null}
      </div>

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
          <ul aria-label="Routine at a glance" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Wakes up" slot={routine.wake} />
            <Fact
              label="Bedtime"
              slot={routine.bedtime}
              extra={routine.night ? `Night about ${routine.night.duration}` : undefined}
            />
            <li className="rounded-xl border border-border bg-card p-4 shadow-soft print:border-foreground/40 print:shadow-none">
              <p className="text-sm font-semibold text-muted-foreground">Naps</p>
              <p className="font-editorial text-2xl font-bold">
                {!naps ? "Not enough data" : naps.slots.length || naps.minCount === naps.maxCount ? `${naps.usualCount} a day` : `${naps.minCount} to ${naps.maxCount} a day`}
              </p>
              {naps ? (
                <p className="text-xs text-muted-foreground">
                  {naps.slots.length ? `On ${naps.daysWithUsualCount} of ${naps.daysCounted} days` : "Varies too much to list times"}
                </p>
              ) : null}
            </li>
            <li className="rounded-xl border border-border bg-card p-4 shadow-soft print:border-foreground/40 print:shadow-none">
              <p className="text-sm font-semibold text-muted-foreground">Feeds</p>
              <p className="font-editorial text-2xl font-bold">{feeds ? `About ${feeds.usualCount} by day` : "Not enough data"}</p>
              {feeds ? (
                <p className="text-xs text-muted-foreground">
                  {[
                    feeds.interval ? `Roughly every ${feeds.interval}` : null,
                    feeds.nightFeeds ? `${formatCount(feeds.nightFeeds.perNight)} at night` : null
                  ].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </li>
          </ul>

          <Card className="space-y-3 print:border-foreground/40 print:shadow-none">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Typical day</h2>
              <p className="text-xs font-semibold text-muted-foreground print:hidden">From {range}</p>
            </div>
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
        </>
      )}
    </div>
  );
}

function Fact({ label, slot, extra }: { label: string; slot: RoutineSlot | null; extra?: string }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 shadow-soft print:border-foreground/40 print:shadow-none">
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
      <p className="font-editorial text-2xl font-bold">{slot ? `Around ${slot.time}` : "Not enough data"}</p>
      {slot ? (
        <p className="text-xs text-muted-foreground">
          {[spreadText(slot, "Varies by about"), extra].filter(Boolean).join(" · ") || `On ${slot.days} days`}
        </p>
      ) : null}
    </li>
  );
}

function spreadText(slot: RoutineSlot, prefix = "±") {
  if (slot.spreadMinutes < 5) return "";
  return prefix === "±" ? `± ${slot.spreadMinutes} min` : `${prefix} ${slot.spreadMinutes} min`;
}

function formatCount(value: number) {
  if (value === 0) return "None";
  return `About ${Number.isInteger(value) ? value : value.toFixed(1)}`;
}

function formatDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}
