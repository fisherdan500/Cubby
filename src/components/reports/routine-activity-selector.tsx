"use client";

import { Check, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { ActivityArtwork } from "@/components/activity-artwork";
import { activityLabels } from "@/domain/activity";
import {
  defaultRoutineActivityTypes,
  routineActivityTypes,
  type RoutineActivityType
} from "@/domain/routine";
import { cn } from "@/lib/utils";

type RoutineActivitySelectorProps = {
  selected: readonly RoutineActivityType[];
  onChange: (next: RoutineActivityType[]) => void;
};

export function RoutineActivitySelector({ selected, onChange }: RoutineActivitySelectorProps) {
  const [expanded, setExpanded] = useState(false);
  const selectedSet = new Set(selected);
  const allSelected = selected.length === routineActivityTypes.length;
  const defaultsSelected =
    selected.length === defaultRoutineActivityTypes.length &&
    defaultRoutineActivityTypes.every((type) => selectedSet.has(type));
  const countLabel = allSelected ? "All shown" : `${selected.length} shown`;

  function toggle(type: RoutineActivityType) {
    onChange(selectedSet.has(type) ? selected.filter((item) => item !== type) : [...selected, type]);
  }

  return (
    <div className="w-full sm:w-auto">
      <button
        type="button"
        className="inline-flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 text-sm font-black hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
        aria-expanded={expanded}
        aria-controls="routine-activity-options"
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          Activities
        </span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {countLabel}
        </span>
      </button>

      {expanded ? (
        <div id="routine-activity-options" className="mt-3 rounded-xl border border-border bg-background p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {routineActivityTypes.map((type) => {
              const checked = selectedSet.has(type);
              return (
                <label key={type} className="cursor-pointer">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={checked}
                    onChange={() => toggle(type)}
                  />
                  <span
                    className={cn(
                      "flex min-h-16 items-center gap-2 rounded-xl border px-2 py-2 text-sm font-bold transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                      checked
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <span className="relative shrink-0">
                      <ActivityArtwork type={type} size="sm" />
                      {checked ? (
                        <span
                          className="absolute -right-1 -top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-sm"
                          aria-hidden="true"
                        >
                          <Check className="h-3 w-3" strokeWidth={3} />
                        </span>
                      ) : null}
                    </span>
                    <span>{activityLabels[type]}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground">Saved on this browser</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="min-h-10 rounded-lg px-3 text-xs font-black text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={allSelected}
                onClick={() => onChange([...routineActivityTypes])}
              >
                Show all
              </button>
              <button
                type="button"
                className="min-h-10 rounded-lg px-3 text-xs font-black text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={defaultsSelected}
                onClick={() => onChange([...defaultRoutineActivityTypes])}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
