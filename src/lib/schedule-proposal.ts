import {
  parsePlannedScheduleItems,
  startMinutes,
  type PlannedScheduleItem,
  type PlannedScheduleKind,
  type PlannedScheduleTiming
} from "@/domain/planned-schedule";
import type { ObservedRoutine } from "@/lib/observed-routine";

/**
 * A review-only plan suggested from the observed Routine (DEC-PROD-152 to 154, DEC-PROD-420 step 3).
 * Every suggestion carries the evidence behind it - how many days, how much the time moved, which
 * days were left out and why - and a plain-language confidence that is not a probability or a care
 * score. Where the logs cannot support a time, nothing is suggested and the reason is shown. Nothing
 * here changes a plan: only the caregiver's explicit, item-by-item choices do, and absence from a
 * suggestion never removes anything.
 *
 * Rules (version 1, deterministic): a time that moved 10 minutes or less is suggested as that time;
 * one that moved more, as a window of the usual time plus or minus that spread, to the quarter hour;
 * one that moved more than 90 minutes, or a window that would cross midnight into a time, is handled
 * as described below. Naps and feeds use only the days with the usual number of them.
 */

export const SCHEDULE_PROPOSAL_RULES_VERSION = 1;

const EXACT_SPREAD_MAX = 10;
const SUGGEST_SPREAD_MAX = 90;
const MATCH_DISTANCE_MAX = 120;
const MINUTES_PER_DAY = 24 * 60;

export type ProposalRoutine = Pick<
  ObservedRoutine,
  "startKey" | "endKey" | "windowDays" | "daysWithData" | "enoughData" | "naps" | "feeds" | "timeline"
>;

export type ProposalConfidence = "steady" | "fairly_steady" | "varies";

export type ScheduleProposalItem = {
  id: string;
  kind: PlannedScheduleKind;
  label: string;
  proposed: PlannedScheduleTiming;
  evidence: { days: number; windowDays: number; spreadMinutes: number; leftOutDays: number; startKey: string; endKey: string };
  confidence: ProposalConfidence;
  confidenceText: string;
  change: { type: "add" } | { type: "change"; currentIndex: number; current: PlannedScheduleTiming };
};

export type ScheduleProposal = {
  items: ScheduleProposalItem[];
  omitted: Array<{ label: string; reason: string }>;
  alreadyPlanned: string[];
  limitation: string | null;
};

const plannableKinds: Partial<Record<string, PlannedScheduleKind>> = {
  wake: "wake",
  nap: "nap",
  feed: "feeding",
  bedtime: "bedtime",
  bath: "bath",
  play: "play",
  pumping: "pumping"
};

const confidenceTexts: Record<ProposalConfidence, string> = {
  steady: "Steady: it happened close to this time on most days.",
  fairly_steady: "Fairly steady: usually around this time, give or take.",
  varies: "Varies: it moved around a fair bit, so treat this as a rough guide."
};

function clock(minutes: number) {
  const value = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function roundTo(minutes: number, step: number) {
  return Math.round(minutes / step) * step;
}

function proposedTiming(minutes: number, spread: number): PlannedScheduleTiming {
  if (spread <= EXACT_SPREAD_MAX) return { mode: "exact", at: clock(roundTo(minutes, 5)) };
  const from = roundTo(minutes - spread, 15);
  const to = roundTo(minutes + spread, 15);
  // A plan's window cannot cross midnight, so a late-evening time stays a single time.
  if (from < 0 || to >= MINUTES_PER_DAY) return { mode: "exact", at: clock(roundTo(minutes, 5)) };
  return { mode: "window", from: clock(from), to: clock(to) };
}

function confidenceFor(days: number, spread: number): ProposalConfidence {
  if (days >= 7 && spread <= 20) return "steady";
  if (days >= 4 && spread <= 45) return "fairly_steady";
  return "varies";
}

function sameTiming(left: PlannedScheduleTiming, right: PlannedScheduleTiming) {
  return left.mode === "exact" && right.mode === "exact"
    ? left.at === right.at
    : left.mode === "window" && right.mode === "window" && left.from === right.from && left.to === right.to;
}

export function proposeScheduleFromRoutine(routine: ProposalRoutine, current: readonly PlannedScheduleItem[]): ScheduleProposal {
  if (!routine.enoughData) {
    return { items: [], omitted: [], alreadyPlanned: [], limitation: "There is not enough logged yet to suggest a plan." };
  }
  const items: ScheduleProposalItem[] = [];
  const omitted: ScheduleProposal["omitted"] = [];
  const alreadyPlanned: string[] = [];
  const matched = new Set<number>();

  for (const entry of routine.timeline) {
    const kind = plannableKinds[entry.kind];
    if (!kind) {
      omitted.push({ label: entry.label, reason: "Medicine and supplements are not planned here yet." });
      continue;
    }
    const { minutes, spreadMinutes, days } = entry.slot;
    if (spreadMinutes > SUGGEST_SPREAD_MAX) {
      omitted.push({ label: entry.label, reason: `It varies too much (about ${spreadMinutes} minutes either way) to suggest a time.` });
      continue;
    }
    const pattern = entry.kind === "nap" ? routine.naps : entry.kind === "feed" ? routine.feeds : null;
    const leftOutDays = pattern ? pattern.daysCounted - pattern.daysWithUsualCount : Math.max(0, routine.windowDays - days);
    const proposed = proposedTiming(minutes, spreadMinutes);

    // The nearest unmatched plan item of the same kind within two hours is the one this would change.
    let match: { index: number; distance: number } | null = null;
    for (const [index, item] of current.entries()) {
      if (item.kind !== kind || matched.has(index)) continue;
      const difference = Math.abs(startMinutes(item.timing) - minutes) % MINUTES_PER_DAY;
      const distance = Math.min(difference, MINUTES_PER_DAY - difference);
      if (distance <= MATCH_DISTANCE_MAX && (!match || distance < match.distance)) match = { index, distance };
    }
    if (match) matched.add(match.index);
    if (match && sameTiming(current[match.index].timing, proposed)) {
      alreadyPlanned.push(entry.label);
      continue;
    }

    const confidence = confidenceFor(days, spreadMinutes);
    items.push({
      id: entry.id,
      kind,
      label: entry.label,
      proposed,
      evidence: { days, windowDays: routine.windowDays, spreadMinutes, leftOutDays, startKey: routine.startKey, endKey: routine.endKey },
      confidence,
      confidenceText: confidenceTexts[confidence],
      change: match ? { type: "change", currentIndex: match.index, current: current[match.index].timing } : { type: "add" }
    });
  }

  const listed = new Set(routine.timeline.map((entry) => entry.kind));
  if (routine.naps && routine.naps.maxCount > 0 && !listed.has("nap")) {
    omitted.push({ label: "Naps", reason: "Naps vary too much day to day to suggest their times." });
  }
  if (routine.feeds && !listed.has("feed")) {
    omitted.push({ label: "Feeds", reason: "Feeds vary too much day to day to suggest their times." });
  }
  return { items, omitted, alreadyPlanned, limitation: null };
}

export type ProposalChoice =
  | { choice: "accept" }
  | { choice: "edit"; timing: PlannedScheduleTiming }
  | { choice: "reject" };

/**
 * The plan that results from the caregiver's choices: accepted and edited suggestions are added or
 * change the one item they were matched to; everything else - rejected, undecided, and every plan
 * item no suggestion touched - stays exactly as it was.
 */
export function applyProposalChoices(
  current: readonly PlannedScheduleItem[],
  items: readonly ScheduleProposalItem[],
  choices: Readonly<Record<string, ProposalChoice | undefined>>
) {
  const next: Array<{ item: PlannedScheduleItem; status: "kept" | "added" | "changed" }> = current.map((item) => ({ item: { ...item }, status: "kept" }));
  const counts = { added: 0, changed: 0, rejected: 0, undecided: 0 };
  for (const item of items) {
    const choice = choices[item.id];
    if (!choice) {
      counts.undecided += 1;
      continue;
    }
    if (choice.choice === "reject") {
      counts.rejected += 1;
      continue;
    }
    const timing = choice.choice === "edit" ? choice.timing : item.proposed;
    if (item.change.type === "change") {
      const index = item.change.currentIndex;
      next[index] = { item: { ...next[index].item, timing }, status: "changed" };
      counts.changed += 1;
    } else {
      next.push({ item: { kind: item.kind, label: null, timing, note: null }, status: "added" });
      counts.added += 1;
    }
  }
  // Validated as a whole plan, then kept in the plan's own time order with what changed marked.
  const plan = parsePlannedScheduleItems(next.map((entry) => entry.item));
  const entries = [...next].sort((left, right) => startMinutes(left.item.timing) - startMinutes(right.item.timing));
  return { items: plan, entries, counts };
}
