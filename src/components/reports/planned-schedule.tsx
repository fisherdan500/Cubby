"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Printer, Trash2 } from "lucide-react";
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
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";
import { printSection } from "@/lib/print-section";
import type { PlannedScheduleView } from "@/server/services/planned-schedule";

type OperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };
type Draft = { key: number; kind: PlannedScheduleKind; label: string; mode: "exact" | "window"; at: string; from: string; to: string; note: string };

const STALE_MESSAGE = "Someone changed this plan while you were editing. Reload the page to see their version before saving yours.";

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

async function operationResponse(response: Response) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: { status?: OperationStatus; operationId?: string };
    error?: { code?: string; message?: string };
  } | null;
  return { response, body, status: body?.ok ? body.data?.status : undefined };
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
export function PlannedSchedulePanel({ babyName, schedule }: { babyName: string; schedule: PlannedScheduleView }) {
  const router = useRouter();
  const nextKey = useRef(0);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { babyId, items, canEdit, revision } = schedule;

  function startEditing() {
    setError("");
    setDrafts(items.map((item) => toDraft(item, nextKey.current++)));
  }

  function update(key: number, change: Partial<Draft>) {
    setDrafts((current) => current?.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)) ?? null);
  }

  function addItem() {
    setDrafts((current) => [...(current ?? []), { key: nextKey.current++, kind: "feeding", label: "", mode: "exact", at: "", from: "", to: "", note: "" }]);
  }

  async function submitReservation(operationId: string, storageKey: string, planned: PlannedScheduleItem[]) {
    const result = await operationResponse(await fetch(`/api/babies/${encodeURIComponent(babyId)}/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, expectedRevision: revision, items: planned })
    }));
    if (isAuthorizedBrowserOperation410(result.response.status, result.body, operationId)) {
      sessionStorage.removeItem(storageKey);
      setError("This save expired. Save again to open a new request.");
    } else if (result.status === "completed") {
      sessionStorage.removeItem(storageKey);
      setDrafts(null);
      router.refresh();
    } else if (result.status === "pending") {
      setError("The save is still in progress. Try again in a moment to check whether it went through.");
    } else if (result.status === "stale" || result.status === "rejected" || result.body?.error?.code === "stale_revision") {
      sessionStorage.removeItem(storageKey);
      setError(STALE_MESSAGE);
    } else {
      setError(result.body?.error?.message ?? "Could not save the plan. Try again.");
    }
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
    setError("");
    setSubmitting(true);
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, `cubby:planned-schedule-operation:${partition}:${babyId}`);
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const reconciled = await operationResponse(await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(reconciled.response.status, reconciled.body, retained)) {
          sessionStorage.removeItem(storageKey);
        } else if (reconciled.status === "completed") {
          sessionStorage.removeItem(storageKey);
          setDrafts(null);
          router.refresh();
          return;
        } else if (reconciled.status === "prepared") {
          await submitReservation(retained, storageKey, planned);
          return;
        } else if (reconciled.status === "pending") {
          setError("The last save is still in progress. Try again in a moment.");
          return;
        } else {
          sessionStorage.removeItem(storageKey);
        }
      }
      const issued = await operationResponse(await fetch(`/api/babies/${encodeURIComponent(babyId)}/schedule?issue=1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision })
      }));
      if (issued.body?.error?.code === "stale_revision") {
        setError(STALE_MESSAGE);
        return;
      }
      const operationId = issued.body?.data?.operationId;
      if (!operationId || (issued.status !== "open" && issued.status !== "prepared")) {
        setError(issued.body?.error?.message ?? "Could not start saving the plan. Try again.");
        return;
      }
      sessionStorage.setItem(storageKey, operationId);
      await submitReservation(operationId, storageKey, planned);
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
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
          {!drafts ? (
            <div className="flex flex-wrap gap-2">
              {items.length ? (
                <Button type="button" variant="secondary" onClick={() => printSection("plan")}>
                  <Printer className="h-4 w-4" aria-hidden="true" />
                  Print plan
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

        {drafts ? (
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
            {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={addItem} disabled={drafts.length >= PLANNED_SCHEDULE_MAX_ITEMS}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add an item
              </Button>
              <Button type="button" onClick={() => void save()} disabled={submitting}>{submitting ? "Saving..." : "Save plan"}</Button>
              <Button type="button" variant="ghost" onClick={() => { setDrafts(null); setError(""); }} disabled={submitting}>Cancel</Button>
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
