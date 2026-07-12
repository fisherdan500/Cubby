"use client";

import { useEffect, useMemo, useState } from "react";
import { ActivityArtwork } from "@/components/activity-artwork";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { RoutineActivitySelector } from "@/components/reports/routine-activity-selector";
import { Card } from "@/components/ui/card";
import { activityLabels } from "@/domain/activity";
import { defaultRoutineActivityTypes, type RoutineActivityType } from "@/domain/routine";
import {
  filterRoutineRows,
  parseRoutineActivitySelection,
  ROUTINE_ACTIVITY_STORAGE_KEY,
  serializeRoutineActivitySelection
} from "@/lib/routine-preferences";
import type { RoutineTimeline } from "@/server/services/reports";

type RoutineTabProps = {
  babyId: string;
  startKey: string;
  endKey: string;
  routine: RoutineTimeline;
};

export function RoutineTab({ babyId, startKey, endKey, routine }: RoutineTabProps) {
  const [selected, setSelected] = useState<RoutineActivityType[]>([...defaultRoutineActivityTypes]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  useEffect(() => {
    try {
      setSelected(parseRoutineActivitySelection(localStorage.getItem(ROUTINE_ACTIVITY_STORAGE_KEY)));
    } catch {
      setSelected([...defaultRoutineActivityTypes]);
    } finally {
      setPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    try {
      localStorage.setItem(ROUTINE_ACTIVITY_STORAGE_KEY, serializeRoutineActivitySelection(selected));
    } catch {
      // Persistence is optional; the selection still works for this page session.
    }
  }, [preferencesLoaded, selected]);

  const visibleRows = useMemo(() => filterRoutineRows(routine.rows, selected), [routine.rows, selected]);
  const visibleSamples = selected.reduce((total, type) => total + routine.summary.samplesByType[type], 0);

  return (
    <div className="space-y-5">
      <Card className="w-fit max-w-full">
        <AutoSubmitForm className="flex max-w-full flex-wrap gap-3">
          <input name="babyId" type="hidden" value={babyId} />
          <input name="start" type="hidden" value={startKey} />
          <input name="end" type="hidden" value={endKey} />
          <input name="tab" type="hidden" value="routine" />
          <label className="grid gap-1 text-xs font-bold text-muted-foreground">
            Routine window
            <select
              name="routineWindow"
              defaultValue={routine.window}
              className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground sm:w-44"
            >
              <option value="1w">1 week</option>
              <option value="2w">2 weeks</option>
              <option value="1m">1 month</option>
            </select>
          </label>
        </AutoSubmitForm>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {selected.includes("sleep") ? (
          <>
            <Metric label="Avg sleep time" value={routine.summary.averageSleepTime ?? "--"} />
            <Metric label="Avg sleep duration" value={routine.summary.averageSleepDuration} />
          </>
        ) : null}
        {selected.includes("feeding") ? (
          <Metric label="Avg feed time" value={routine.summary.averageFeedTime ?? "--"} />
        ) : null}
        <Metric label="Days with routine data" value={`${routine.daysWithData}/${routine.windowDays}`} />
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
            {visibleSamples} {visibleSamples === 1 ? "sample" : "samples"}
          </p>
        </div>

        <RoutineActivitySelector selected={selected} onChange={setSelected} />

        {selected.length === 0 ? (
          <p className="rounded-lg bg-surface p-4 text-sm text-muted-foreground">
            No activities selected. Choose activities above to build your Typical Day.
          </p>
        ) : visibleRows.length ? (
          <div className="space-y-3">
            {visibleRows.map((row) => {
              const label = activityLabels[row.type];
              return (
                <div key={`${row.type}-${row.index}`} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 rounded-lg bg-surface p-3">
                  <ActivityArtwork type={row.type} size="md" />
                  <div className="min-w-0">
                    <p className="text-sm font-black text-primary">{row.averageTime}</p>
                    <p className="font-black">
                      {label} around {row.averageTime}
                      {row.averageDuration ? ` for ${row.averageDuration}` : ""}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {row.sampleCount} {row.sampleCount === 1 ? "sample" : "samples"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg bg-surface p-4 text-sm text-muted-foreground">
            No recurring activity pattern was found for the selected activities in this routine window.
          </p>
        )}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="font-editorial text-2xl font-bold">{value}</p>
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
    </Card>
  );
}
