"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Printer, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  PLANNED_SCHEDULE_MAX_ITEMS,
  formatScheduleTiming,
  parsePlannedScheduleItems,
  plannedScheduleKindLabels,
  plannedScheduleKinds,
  scheduleItemLabel,
  type PlannedScheduleItem,
  type PlannedScheduleKind
} from "@/domain/planned-schedule";
import { clientOperationResponse, householdPartitionSchema, type OutcomeValidator } from "@/lib/client-operation-response";
import { z } from "zod";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";
import { printSection } from "@/lib/print-section";
import {
  applyProposalChoices,
  proposeScheduleFromRoutine,
  type ProposalChoice,
  type ProposalRoutine,
  type ScheduleProposalItem
} from "@/lib/schedule-proposal";
import type { PlannedScheduleView } from "@/server/services/planned-schedule";

const retainedPlanIntents = new Map<string, { operationId: string; intent: string; validOutcome: OutcomeValidator }>();
function planIntent(babyId: string, revision: number, items: PlannedScheduleItem[]) {
  return JSON.stringify({ babyId, revision, items: parsePlannedScheduleItems(items) });
}
function planOutcomeValidator(babyId: string, revision?: number, itemCount?: number): OutcomeValidator {
  const schema = z.object({ kind: z.literal("planned_schedule"), code: z.literal("ok"), babyId: z.literal(babyId),
    revision: z.number().int().positive(), itemCount: z.number().int().nonnegative() }).strict();
  return (outcome) => {
    const parsed = schema.safeParse(outcome);
    return parsed.success && (revision === undefined || parsed.data.revision === revision + 1) &&
      (itemCount === undefined || parsed.data.itemCount === itemCount);
  };
}
type Partition = { version: 1; scope: "household"; partition: string };
type Draft = { key: number; kind: PlannedScheduleKind; label: string; mode: "exact" | "window"; at: string; from: string; to: string; note: string };

const STALE_MESSAGE = "Someone changed this plan while you were editing. Cancel or close this draft, then reopen the plan to review their version before saving.";

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || body?.ok !== true || !householdPartitionSchema.safeParse(body.data).success) throw new Error("operation_partition_unavailable");
  return householdPartitionSchema.parse(body.data);
}

function toDraft(item: PlannedScheduleItem, key: number): Draft {
  return {
    key,
    kind: item.kind,
    label: item.label ?? "",
    mode: item.timing.mode,
    at: item.timing.mode === "exact" ? item.timing.at : "",
    from: item.timing.mode === "window" ? item.timing.from : "",
    to: item.timing.mode === "window" ? item.timing.to : "",
    note: item.note ?? ""
  };
}

/** The first thing wrong with a draft, in words, or null when it can be saved. */
function draftProblem(drafts: Draft[]) {
  for (const [index, draft] of drafts.entries()) {
    const which = `Item ${index + 1}`;
    if (draft.kind === "custom" && !draft.label.trim()) return `${which} ("Something else") needs a name.`;
    if (draft.mode === "exact" ? !draft.at : !draft.from || !draft.to) return `${which} needs a time.`;
    if (draft.mode === "window" && draft.from >= draft.to) return `${which}: the window has to end after it starts.`;
  }
  return null;
}

function fromDrafts(drafts: Draft[]) {
  return parsePlannedScheduleItems(drafts.map((draft) => ({
    kind: draft.kind,
    label: draft.kind === "custom" ? draft.label : null,
    timing: draft.mode === "exact" ? { mode: "exact", at: draft.at } : { mode: "window", from: draft.from, to: draft.to },
    note: draft.note || null
  })));
}

/**
 * The plan a caregiver writes for the baby's day (DEC-PROD-148, DEC-PROD-420), shown beside the
 * routine that was observed and never mixed with it: this is what is meant to happen, not what did.
 * Saving replaces the whole plan, and only from the version the editor was opened on.
 */
type PlannedSchedulePanelProps = {
  babyName: string;
  schedule: PlannedScheduleView;
  /** The observed routine shown beside the plan; when there is one, suggestions can be drawn from it. */
  routine?: ProposalRoutine;
};

export function PlannedSchedulePanel(props: PlannedSchedulePanelProps) {
  return <BabyPlannedSchedulePanel key={props.schedule.babyId} {...props} />;
}

function BabyPlannedSchedulePanel({ babyName, schedule, routine }: PlannedSchedulePanelProps) {
  const router = useRouter();
  const nextKey = useRef(0);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const currentDrafts = useRef(drafts);
  currentDrafts.current = drafts;
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState<{ revision: number; items: PlannedScheduleItem[]; routine?: ProposalRoutine } | null>(null);
  const { babyId, items, canEdit } = schedule;
  const revision = opening?.revision ?? schedule.revision;
  const stale = opening !== null && revision !== schedule.revision;
  const editorError = stale ? STALE_MESSAGE : error;
  const closeEditors = () => {
    setDrafts(null);
    setSuggesting(false);
    setOpening(null);
  };

  function startEditing() {
    setError("");
    setOpening({ revision: schedule.revision, items, routine });
    setDrafts(items.map((item) => toDraft(item, nextKey.current++)));
  }

  function update(key: number, change: Partial<Draft>) {
    setDrafts((current) => current?.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)) ?? null);
  }

  function addItem() {
    setDrafts((current) => [...(current ?? []), { key: nextKey.current++, kind: "feeding", label: "", mode: "exact", at: "", from: "", to: "", note: "" }]);
  }

  async function save() {
    if (!drafts) return;
    const problem = draftProblem(drafts);
    if (problem) {
      setError(problem);
      return;
    }
    let planned: PlannedScheduleItem[];
    try {
      planned = fromDrafts(drafts);
    } catch {
      setError("Something in this plan cannot be saved. Check the names, times and notes.");
      return;
    }
    await saveItems(planned, () => currentDrafts.current ? fromDrafts(currentDrafts.current) : null);
  }

  /** Save a whole plan, only from the revision it was opened on. */
  async function saveItems(planned: PlannedScheduleItem[], currentItems: () => PlannedScheduleItem[] | null) {
    if (!opening || stale || !canEdit) return;
    // Normalize and detach before the first await. The retained ID never owns later edits.
    planned = parsePlannedScheduleItems(planned);
    const intent = planIntent(babyId, revision, planned);
    const validOutcome = planOutcomeValidator(babyId, revision, planned.length);
    const stillCurrent = () => {
      try {
        const current = currentItems();
        return current !== null && planIntent(babyId, revision, current) === intent;
      } catch { return false; }
    };
    setError("");
    setSubmitting(true);
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, `cubby:planned-schedule-operation:${partition}:${babyId}`);
      const forget = () => { sessionStorage.removeItem(storageKey); retainedPlanIntents.delete(storageKey); };
      const complete = (sameIntent: boolean) => {
        forget();
        if (sameIntent && stillCurrent()) { closeEditors(); router.refresh(); }
        else setError("The previous plan was saved. Your current draft was not sent. Review it before saving again.");
      };
      const submitReservation = async (operationId: string) => {
        const result = await clientOperationResponse(await fetch(`/api/babies/${encodeURIComponent(babyId)}/schedule`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId, expectedRevision: revision, items: planned })
        }), validOutcome, operationId);
        if (result.status === "completed") complete(true);
        else if (result.status === "expired" || result.status === "stale" || result.status === "rejected") {
          forget(); setError(result.status === "expired" ? "This save expired. Review the draft and save again." : STALE_MESSAGE);
        } else setError("Could not confirm this save. Your draft is still here. Try again to check.");
      };
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const previous = retainedPlanIntents.get(storageKey);
        const known = previous?.operationId === retained ? previous : undefined;
        const sameIntent = known?.intent === intent;
        const reconciled = await clientOperationResponse(await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" }),
          known?.validOutcome ?? planOutcomeValidator(babyId), retained);
        if (reconciled.status === "completed") complete(sameIntent);
        else if (reconciled.status === "prepared") {
          if (sameIntent) await submitReservation(retained);
          else setError("The previous plan save is unresolved. Restore its original draft to retry, or wait for its expiry; this draft has not been sent.");
        } else if (reconciled.status === "expired" || reconciled.status === "stale" || reconciled.status === "rejected") {
          forget(); setError("The previous save ended. Review your draft before saving again.");
        } else setError("Could not confirm the last save. Your draft is still here. Try again to check.");
        return;
      }
      const issued = await clientOperationResponse(await fetch(`/api/babies/${encodeURIComponent(babyId)}/schedule?issue=1`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision })
      }), validOutcome);
      if (issued.response.status === 409 && issued.body?.ok === false && issued.body.error?.code === "stale_revision") {
        setError(STALE_MESSAGE); return;
      }
      const operationId = issued.body?.data?.operationId;
      if (!operationId || (issued.status !== "open" && issued.status !== "prepared")) {
        setError("Could not start saving the plan. Try again."); return;
      }
      sessionStorage.setItem(storageKey, operationId);
      retainedPlanIntents.set(storageKey, { operationId, intent, validOutcome });
      await submitReservation(operationId);
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally { setSubmitting(false); }
  }

  return (
    <section data-print-section="plan" className="space-y-3">
      <header className="hidden space-y-1 print:block">
        <h2 className="font-editorial text-2xl font-bold">{babyName}&apos;s plan</h2>
        <p className="text-sm">This is the plan for the day, not a record of it: check the latest log for what actually happened.</p>
      </header>

      <Card className="space-y-4 print:border-foreground/40 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
          <div>
            <h2 className="text-base font-semibold">Planned schedule</h2>
            <p className="text-sm text-muted-foreground">What you intend the day to look like. Planned, not what happened: logging never changes it.</p>
          </div>
          {!drafts && !suggesting ? (
            <div className="flex flex-wrap gap-2">
              {items.length ? (
                <Button type="button" variant="secondary" onClick={() => printSection("plan")}>
                  <Printer className="h-4 w-4" aria-hidden="true" />
                  Print plan
                </Button>
              ) : null}
              {canEdit && routine?.enoughData ? (
                <Button type="button" variant="secondary" onClick={() => { setError(""); setOpening({ revision: schedule.revision, items, routine }); setSuggesting(true); }}>
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Suggest from routine
                </Button>
              ) : null}
              {canEdit ? (
                <Button type="button" variant={items.length ? "secondary" : "primary"} onClick={startEditing}>
                  {items.length ? "Edit plan" : "Create a plan"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {suggesting && opening?.routine ? (
          <ScheduleSuggestions
            routine={opening.routine}
            items={opening.items}
            error={editorError}
            saveBlocked={stale || !canEdit}
            submitting={submitting}
            onSave={(planned, current) => void saveItems(planned, current)}
            onClose={() => { closeEditors(); setError(""); }}
          />
        ) : drafts ? (
          <div className="space-y-3 print:hidden">
            {drafts.length === 0 ? <p className="text-sm text-muted-foreground">No items. Add the first one below.</p> : null}
            {drafts.map((draft, index) => (
              <fieldset key={draft.key} aria-label={`Item ${index + 1}`} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                  What
                  <select
                    value={draft.kind}
                    onChange={(event) => update(draft.key, { kind: event.target.value as PlannedScheduleKind })}
                    className="min-h-11 rounded-lg border border-control bg-card px-3 text-sm text-foreground"
                  >
                    {plannedScheduleKinds.map((kind) => <option key={kind} value={kind}>{plannedScheduleKindLabels[kind]}</option>)}
                  </select>
                </label>
                {draft.kind === "custom" ? (
                  <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                    Name
                    <Input value={draft.label} maxLength={60} onChange={(event) => update(draft.key, { label: event.target.value })} placeholder="e.g. Walk to the park" />
                  </label>
                ) : null}
                <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                  When
                  <select
                    value={draft.mode}
                    onChange={(event) => update(draft.key, { mode: event.target.value as Draft["mode"] })}
                    className="min-h-11 rounded-lg border border-control bg-card px-3 text-sm text-foreground"
                  >
                    <option value="exact">At a time</option>
                    <option value="window">Between two times</option>
                  </select>
                </label>
                {draft.mode === "exact" ? (
                  <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                    At
                    <Input type="time" value={draft.at} onChange={(event) => update(draft.key, { at: event.target.value })} />
                  </label>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                      From
                      <Input type="time" value={draft.from} onChange={(event) => update(draft.key, { from: event.target.value })} />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                      To
                      <Input type="time" value={draft.to} onChange={(event) => update(draft.key, { to: event.target.value })} />
                    </label>
                  </div>
                )}
                <label className="grid gap-1 text-xs font-bold text-muted-foreground sm:col-span-2">
                  Note (optional)
                  <Input value={draft.note} maxLength={300} onChange={(event) => update(draft.key, { note: event.target.value })} placeholder="e.g. Warm the bottle first" />
                </label>
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove item ${index + 1}`}
                    onClick={() => setDrafts((current) => current?.filter((item) => item.key !== draft.key) ?? null)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </fieldset>
            ))}
            {editorError ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{editorError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={addItem} disabled={drafts.length >= PLANNED_SCHEDULE_MAX_ITEMS}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add an item
              </Button>
              <Button type="button" onClick={() => void save()} disabled={submitting || stale || !canEdit}>{submitting ? "Saving..." : "Save plan"}</Button>
              <Button type="button" variant="ghost" onClick={() => { closeEditors(); setError(""); }} disabled={submitting}>Cancel</Button>
            </div>
          </div>
        ) : items.length ? (
          <ol aria-label="Planned schedule" className="divide-y divide-border">
            {items.map((item, index) => (
              <li key={index} className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-3 py-2.5 break-inside-avoid">
                <span className="tabular text-sm font-bold text-primary print:text-foreground">{formatScheduleTiming(item.timing)}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{scheduleItemLabel(item)}</span>
                  {item.note ? <span className="block text-xs text-muted-foreground">{item.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            No plan yet.{canEdit ? " Write down when naps, feeds and bedtime are meant to happen, to share with anyone looking after the baby." : ""}
          </p>
        )}
      </Card>
    </section>
  );
}

type Choice = "accept" | "edit" | "reject" | "undecided";
type EditDraft = { mode: "exact" | "window"; at: string; from: string; to: string };

const choiceLabels: Array<[Choice, string]> = [
  ["accept", "Accept"],
  ["edit", "Edit, then accept"],
  ["reject", "Reject"],
  ["undecided", "Decide later"]
];

function editDraftFor(item: ScheduleProposalItem): EditDraft {
  return item.proposed.mode === "exact"
    ? { mode: "exact", at: item.proposed.at, from: "", to: "" }
    : { mode: "window", at: "", from: item.proposed.from, to: item.proposed.to };
}

function formatDayKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Suggestions drawn from the observed routine (DEC-PROD-152 to 154). Each one shows its evidence and
 * confidence and starts undecided; only what the caregiver accepts - as suggested, or edited - enters
 * a final preview of the whole resulting plan, and only saving that changes anything. Choices are
 * kept on this screen alone: closing it forgets them.
 */
function ScheduleSuggestions({
  routine,
  items,
  error,
  saveBlocked,
  submitting,
  onSave,
  onClose
}: {
  routine: ProposalRoutine;
  items: PlannedScheduleItem[];
  error: string;
  saveBlocked: boolean;
  submitting: boolean;
  onSave: (planned: PlannedScheduleItem[], current: () => PlannedScheduleItem[] | null) => void;
  onClose: () => void;
}) {
  const [proposal] = useState(() => proposeScheduleFromRoutine(routine, items));
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [edits, setEdits] = useState<Record<string, EditDraft>>({});
  const [outcome, setOutcome] = useState<ReturnType<typeof applyProposalChoices> | null>(null);
  const currentOutcome = useRef(outcome);
  currentOutcome.current = outcome;
  const [problem, setProblem] = useState("");

  const chosen = (id: string) => choices[id] ?? "undecided";
  const anyAccepted = proposal.items.some((item) => chosen(item.id) === "accept" || chosen(item.id) === "edit");

  function decisions(): Record<string, ProposalChoice> | null {
    const result: Record<string, ProposalChoice> = {};
    for (const item of proposal.items) {
      const choice = chosen(item.id);
      if (choice === "accept" || choice === "reject") result[item.id] = { choice };
      if (choice === "edit") {
        const edit = edits[item.id] ?? editDraftFor(item);
        if (edit.mode === "exact" ? !edit.at : !edit.from || !edit.to || edit.from >= edit.to) {
          setProblem(`${item.label} needs a time${edit.mode === "window" ? " window that ends after it starts" : ""}.`);
          return null;
        }
        result[item.id] = { choice: "edit", timing: edit.mode === "exact" ? { mode: "exact", at: edit.at } : { mode: "window", from: edit.from, to: edit.to } };
      }
    }
    return result;
  }

  function reviewChanges() {
    setProblem("");
    const decided = decisions();
    if (!decided) return;
    const additions = proposal.items.filter((item) => item.change.type === "add" && (decided[item.id]?.choice === "accept" || decided[item.id]?.choice === "edit")).length;
    if (items.length + additions > PLANNED_SCHEDULE_MAX_ITEMS) {
      setProblem(`A plan can have at most ${PLANNED_SCHEDULE_MAX_ITEMS} items. Reject some additions, or close suggestions and remove items from the plan first.`);
      return;
    }
    try {
      setOutcome(applyProposalChoices(items, proposal.items, decided));
    } catch {
      setProblem("These changes cannot be saved. Check the suggested times and try again.");
    }
  }

  if (outcome) {
    const { added, changed, rejected, undecided } = outcome.counts;
    return (
      <div className="space-y-3 print:hidden">
        <h3 className="text-sm font-semibold">Check the plan before saving</h3>
        <p className="text-sm text-muted-foreground">{`${added} added, ${changed} changed, ${rejected} rejected, ${undecided} left undecided.`} Everything else stays as it is.</p>
        <ol aria-label="Plan after these changes" className="divide-y divide-border">
          {outcome.entries.map((entry, index) => (
            <li key={index} className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)_auto] items-center gap-3 py-2.5">
              <span className="tabular text-sm font-bold text-primary">{formatScheduleTiming(entry.item.timing)}</span>
              <span className="min-w-0 text-sm font-semibold">{scheduleItemLabel(entry.item)}</span>
              {entry.status === "kept" ? <span /> : (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary">{entry.status === "added" ? "New" : "Changed"}</span>
              )}
            </li>
          ))}
        </ol>
        {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onSave(outcome.items, () => currentOutcome.current?.items ?? null)} disabled={submitting || saveBlocked}>{submitting ? "Saving..." : "Save to plan"}</Button>
          <Button type="button" variant="ghost" onClick={() => setOutcome(null)} disabled={submitting}>Back to suggestions</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 print:hidden">
      <div>
        <h3 className="text-sm font-semibold">Suggestions from the routine</h3>
        <p className="text-sm text-muted-foreground">
          Worked out from what was logged, {formatDayKey(routine.startKey)} to {formatDayKey(routine.endKey)}. These are observations, not advice:
          nothing changes until you choose for each one and save.
        </p>
      </div>
      {proposal.limitation ? <p className="text-sm text-muted-foreground">{proposal.limitation}</p> : null}
      {proposal.items.map((item) => {
        const choice = chosen(item.id);
        const edit = edits[item.id] ?? editDraftFor(item);
        const setEdit = (change: Partial<EditDraft>) => setEdits((current) => ({ ...current, [item.id]: { ...edit, ...change } }));
        const { days, windowDays, spreadMinutes, leftOutDays } = item.evidence;
        return (
          <fieldset key={item.id} aria-label={item.label} className="space-y-2 rounded-lg border border-border p-3">
            <legend className="sr-only">{item.label}</legend>
            <p className="text-sm font-semibold">
              {item.label}: <span className="tabular text-primary">{formatScheduleTiming(item.proposed)}</span>
            </p>
            {item.change.type === "change" ? (
              <p className="text-xs text-muted-foreground">Now in your plan: {formatScheduleTiming(item.change.current)}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {[
                `Seen on ${days} of ${windowDays} days`,
                spreadMinutes >= 5 ? `moves about ${spreadMinutes} min either way` : null,
                leftOutDays ? `${leftOutDays} ${leftOutDays === 1 ? "day" : "days"} left out${item.kind === "nap" || item.kind === "feeding" ? " (a different number that day)" : " (not logged)"}` : null
              ].filter(Boolean).join(" · ")}
            </p>
            <p className="text-xs text-muted-foreground">{item.confidenceText}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {choiceLabels.map(([value, label]) => (
                <label key={value} className="inline-flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name={`suggestion-${item.id}`}
                    checked={choice === value}
                    onChange={() => { setProblem(""); setChoices((current) => ({ ...current, [item.id]: value })); }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {choice === "edit" ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                  When
                  <select
                    value={edit.mode}
                    onChange={(event) => setEdit({ mode: event.target.value as EditDraft["mode"] })}
                    className="min-h-11 rounded-lg border border-control bg-card px-3 text-sm text-foreground"
                  >
                    <option value="exact">At a time</option>
                    <option value="window">Between two times</option>
                  </select>
                </label>
                {edit.mode === "exact" ? (
                  <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                    At
                    <Input type="time" value={edit.at} onChange={(event) => setEdit({ at: event.target.value })} />
                  </label>
                ) : (
                  <>
                    <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                      From
                      <Input type="time" value={edit.from} onChange={(event) => setEdit({ from: event.target.value })} />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                      To
                      <Input type="time" value={edit.to} onChange={(event) => setEdit({ to: event.target.value })} />
                    </label>
                  </>
                )}
              </div>
            ) : null}
          </fieldset>
        );
      })}
      {proposal.alreadyPlanned.length ? (
        <p className="text-xs text-muted-foreground">Already in your plan as observed: {proposal.alreadyPlanned.join(", ")}.</p>
      ) : null}
      {proposal.omitted.length ? (
        <div className="text-xs text-muted-foreground">
          <p className="font-semibold">Not suggested</p>
          <ul className="list-disc pl-5">
            {proposal.omitted.map((entry) => <li key={entry.label}>{entry.label}: {entry.reason}</li>)}
          </ul>
        </div>
      ) : null}
      {problem ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{problem}</p> : null}
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!anyAccepted} onClick={reviewChanges}>Review changes</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Close suggestions</Button>
      </div>
    </div>
  );
}
