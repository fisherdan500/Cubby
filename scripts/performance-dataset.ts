// Deterministic synthetic household history for the performance budgets in DEC-PROD-225, sized by
// DEC-PROD-226 ("approximately one and five years of realistic use across multiple babies, typed
// activities, timers, corrections/reversals, notes"). No production content: every row is generated
// from a fixed seed and a fixed end date, so a rerun on any machine produces byte-identical data and
// two runs are comparable.

export type PerformanceDatasetInput = {
  years: 1 | 5;
  householdId: string;
  memberId: string;
  babyIds: readonly string[];
  /** The dataset's most recent day. Fixed by the caller so timings never depend on the wall clock. */
  endDate: Date;
};

export type PerformanceActivityRow = {
  id: string;
  householdId: string;
  babyId: string;
  actorMemberId: string;
  type: string;
  occurredAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  timezone: string;
  notes: string | null;
  timerState: "none";
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PerformanceDataset = {
  activities: PerformanceActivityRow[];
  feedings: Array<{ activityId: string; mode: string; amount: string | null; unit: string | null; side: string | null }>;
  diapers: Array<{ activityId: string; kind: string; rashConcern: boolean }>;
  sleeps: Array<{ activityId: string; sleepType: string; quality: string | null }>;
  notes: Array<{ activityId: string; text: string; category: string | null }>;
  counts: { days: number; babies: number; activities: number; corrected: number; perType: Record<string, number> };
};

/** Small deterministic PRNG (mulberry32); no dependency and identical across platforms. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// One ordinary day for one baby: the shape a household actually accumulates, not a uniform stream.
const dayPlan = [
  { type: "feeding", hour: 2 }, { type: "diaper", hour: 2 },
  { type: "sleep", hour: 3, durationMinutes: 180 },
  { type: "feeding", hour: 6 }, { type: "diaper", hour: 6 },
  { type: "feeding", hour: 9 }, { type: "sleep", hour: 10, durationMinutes: 90 },
  { type: "diaper", hour: 11 }, { type: "feeding", hour: 12 },
  { type: "note", hour: 13 }, { type: "feeding", hour: 15 }, { type: "diaper", hour: 15 },
  { type: "sleep", hour: 16, durationMinutes: 60 }, { type: "feeding", hour: 18 },
  { type: "diaper", hour: 19 }, { type: "feeding", hour: 21 },
  { type: "sleep", hour: 22, durationMinutes: 240 }, { type: "feeding", hour: 23 }
] as const;

export function performanceDataset(input: PerformanceDatasetInput): PerformanceDataset {
  const days = input.years * 365;
  const next = random(0x0cabb1 + input.years);
  const dataset: PerformanceDataset = {
    activities: [],
    feedings: [],
    diapers: [],
    sleeps: [],
    notes: [],
    counts: { days, babies: input.babyIds.length, activities: 0, corrected: 0, perType: {} }
  };
  const endDay = Date.UTC(input.endDate.getUTCFullYear(), input.endDate.getUTCMonth(), input.endDate.getUTCDate());

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = endDay - dayOffset * 86_400_000;
    for (const [babyIndex, babyId] of input.babyIds.entries()) {
      for (const [slot, entry] of dayPlan.entries()) {
        const minute = Math.floor(next() * 60);
        const occurredAt = new Date(dayStart + entry.hour * 3_600_000 + minute * 60_000 + babyIndex * 7 * 60_000);
        const id = `perf_${dataset.activities.length.toString(36).padStart(9, "0")}`;
        const timed = entry.type === "sleep";
        const durationSeconds = timed ? ("durationMinutes" in entry ? entry.durationMinutes : 60) * 60 : null;
        // A small share of history is corrected away, as real households do; these must stay out of
        // every list and aggregate, which is part of what the queries under test have to filter.
        const corrected = next() < 0.01;

        dataset.activities.push({
          id,
          householdId: input.householdId,
          babyId,
          actorMemberId: input.memberId,
          type: entry.type,
          occurredAt,
          startedAt: timed ? occurredAt : null,
          endedAt: timed && durationSeconds ? new Date(occurredAt.getTime() + durationSeconds * 1000) : null,
          durationSeconds,
          timezone: "Etc/UTC",
          notes: slot % 6 === 0 ? `Synthetic note ${id}` : null,
          timerState: "none",
          deletedAt: corrected ? new Date(occurredAt.getTime() + 3_600_000) : null,
          createdAt: occurredAt,
          updatedAt: occurredAt
        });
        if (corrected) dataset.counts.corrected += 1;
        dataset.counts.perType[entry.type] = (dataset.counts.perType[entry.type] ?? 0) + 1;

        if (entry.type === "feeding") {
          const bottle = next() < 0.6;
          dataset.feedings.push({
            activityId: id,
            mode: bottle ? "bottle" : "breast",
            amount: bottle ? (2 + Math.floor(next() * 6)).toString() : null,
            unit: bottle ? "oz" : null,
            side: bottle ? null : next() < 0.5 ? "left" : "right"
          });
        } else if (entry.type === "diaper") {
          dataset.diapers.push({ activityId: id, kind: next() < 0.5 ? "wet" : "mixed", rashConcern: next() < 0.03 });
        } else if (entry.type === "sleep") {
          dataset.sleeps.push({ activityId: id, sleepType: entry.hour >= 20 || entry.hour <= 5 ? "night" : "nap", quality: next() < 0.5 ? "settled" : null });
        } else {
          dataset.notes.push({ activityId: id, text: `Synthetic care note for ${id}`, category: next() < 0.5 ? "general" : null });
        }
      }
    }
  }

  dataset.counts.activities = dataset.activities.length;
  return dataset;
}
