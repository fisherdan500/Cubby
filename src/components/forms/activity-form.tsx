"use client";

import Link from "next/link";
import type { InputHTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { scrollRow, useFollowNow, WhenField, type WhenValue } from "@/components/forms/when-field";
import { activityLabels, timerActivityTypes, type ActivityTypeName } from "@/domain/activity";
import type { UnitPreferences } from "@/domain/unit-preferences";
import { normalizeVolumeUnit } from "@/domain/units";
import {
  activityFormCancelHref,
  activityFormSuccessHref,
  hasActivityDetail,
  resolveFormUnit,
  resolveItemDoseUnit
} from "@/lib/activity-form";
import { displayLabel } from "@/lib/display-label";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";
import { cn } from "@/lib/utils";
import { addMinutes, formatClock, formatMinutes, isWallTime, minutesBetween, nowWallTime } from "@/lib/wall-time";

type BabyOption = { id: string; name: string };
type ActivityOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };
type Initial = Record<string, string | number | boolean | null | undefined>;
type Slots = {
  initial?: Initial;
  editing: boolean;
  preferences: UnitPreferences;
  medicineNames: string[];
  supplementNames: string[];
  when: ReactNode;
  notes: ReactNode;
};

function activityOperationStorageKey(partition: string, activityId: string | undefined, type: ActivityTypeName) {
  return `cubby:activity-form-operation:${partition}:${activityId ?? `create:${type}`}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

async function activityOperationResponse(response: Response) {
  const result = (await response.json().catch(() => null)) as
    | { ok: true; data?: { status?: ActivityOperationStatus; operationId?: string } }
    | { ok: false; error?: { message?: string } }
    | null;
  return { response, result, status: result?.ok ? result.data?.status : undefined };
}

export function ActivityForm({
  babies,
  type,
  initial,
  activityId,
  selectedBabyId,
  returnDate,
  returnTo,
  successTo,
  allowActivityDestination,
  appTimeZone,
  unitPreferences,
  medicineNames,
  supplementNames
}: {
  babies: BabyOption[];
  type: ActivityTypeName;
  initial?: Initial;
  activityId?: string;
  selectedBabyId?: string;
  returnDate?: string;
  returnTo?: string;
  successTo?: string;
  allowActivityDestination?: boolean;
  appTimeZone: string;
  unitPreferences: UnitPreferences;
  medicineNames: string[];
  supplementNames: string[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestedBaby = String(initial?.babyId ?? selectedBabyId ?? "");
  const defaultBaby = babies.some((baby) => baby.id === requestedBaby) ? requestedBaby : String(babies[0]?.id ?? "");
  const cancelHref = activityFormCancelHref({ returnTo, babyId: defaultBaby, returnDate, allowActivityDestination });
  const timed = timerActivityTypes.includes(type as (typeof timerActivityTypes)[number]);
  const savedStart = textValue(initial?.startedAt);
  const savedEnd = textValue(initial?.endedAt);
  const savedOccurred = textValue(initial?.occurredAt);
  const [when, setWhen] = useState<WhenValue>(() => {
    const saved = timed && isWallTime(savedStart) ? savedStart : savedOccurred;
    return isWallTime(saved) ? { value: saved, followsNow: false } : { value: nowWallTime(appTimeZone), followsNow: true };
  });
  const [lengthMinutes, setLengthMinutes] = useState<number | null>(() =>
    isWallTime(savedStart) && isWallTime(savedEnd) ? Math.max(0, minutesBetween(savedStart, savedEnd)) : null
  );
  const [activeTimer, setActiveTimer] = useState(false);
  useFollowNow(when, setWhen, appTimeZone);

  function clearOperation(storageKey: string) {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Storage failure must not affect the terminal server outcome.
    }
  }

  function finish(storageKey: string, body: Record<string, FormDataEntryValue>) {
    clearOperation(storageKey);
    const destination = activityFormSuccessHref({
      successTo,
      babyId: String(body.babyId || defaultBaby),
      returnDate,
      allowActivityDestination
    });
    if (allowActivityDestination) router.replace(destination);
    else router.push(destination);
    router.refresh();
  }

  async function submit(formData: FormData) {
    setError("");
    setSubmitting(true);
    const body = Object.fromEntries(formData);
    body.type = type;
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, activityOperationStorageKey(partition, activityId, type));
      let currentOperationId = sessionStorage.getItem(storageKey) ?? undefined;
      if (currentOperationId) {
        const reconciled = await activityOperationResponse(await fetch(`/api/browser-operations/${currentOperationId}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(reconciled.response.status, reconciled.result, currentOperationId)) {
          clearOperation(storageKey);
          currentOperationId = undefined;
        } else if (reconciled.status === "completed") {
          finish(storageKey, body);
          return;
        } else if (reconciled.status === "pending") {
          setError("This activity request is still in progress. Reconcile it before changing it again.");
          return;
        } else if (reconciled.status === "stale" || reconciled.status === "rejected") {
          setError("This activity request is no longer current. Refresh and review the form before trying again.");
          return;
        } else if (reconciled.status !== "open" && reconciled.status !== "prepared") {
          setError("Reconcile this activity request before trying again.");
          return;
        }
      }
      if (!currentOperationId) {
        const endpoint = activityId ? `/api/activities/${activityId}?issue=1` : "/api/activities?issue=1";
        const issued = await activityOperationResponse(await fetch(endpoint, {
          method: activityId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ babyId: body.babyId })
        }));
        if (!issued.response.ok || !issued.result?.ok || !issued.status || (issued.status !== "open" && issued.status !== "prepared")) {
          throw new Error("activity_operation_issue_unavailable");
        }
        currentOperationId = issued.result.data?.operationId;
        if (!currentOperationId) throw new Error("activity_operation_issue_unavailable");
        sessionStorage.setItem(storageKey, currentOperationId);
      }
      body.operationId = currentOperationId;
      const submitted = await activityOperationResponse(await fetch(activityId ? `/api/activities/${activityId}` : "/api/activities", {
        method: activityId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }));
      if (isAuthorizedBrowserOperation410(submitted.response.status, submitted.result, currentOperationId)) {
        clearOperation(storageKey);
        setError("This activity request expired. Submit again to open a new request.");
        return;
      }
      if (submitted.status === "completed") {
        finish(storageKey, body);
        return;
      }
      if (submitted.status === "pending") {
        setError("This activity request is still in progress. Reconcile it before changing it again.");
        return;
      }
      if (submitted.status === "stale" || submitted.status === "rejected") {
        setError("This activity request is no longer current. Refresh and review the form before trying again.");
        return;
      }
      setError("Reconcile this activity request before trying again.");
    } catch {
      setError("Reconcile this activity request before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  const whenSection = (
    <div className="space-y-4 border-t border-border pt-4">
      <WhenField label={timed ? "Started" : "Time"} when={when} onChange={setWhen} timeZone={appTimeZone} />
      <input type="hidden" name="occurredAt" value={when.value} />
      {timed ? (
        <>
          <input type="hidden" name="startedAt" value={when.value} />
          <input type="hidden" name="endedAt" value={!activeTimer && lengthMinutes ? addMinutes(when.value, lengthMinutes) : ""} />
          {activeTimer ? null : <LengthField minutes={lengthMinutes} onChange={setLengthMinutes} start={when.value} />}
          {!activityIdField(initial) ? (
            <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
              <input name="activeTimer" type="checkbox" checked={activeTimer} onChange={(event) => setActiveTimer(event.target.checked)} className="h-5 w-5" />
              Still going — start a timer instead
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );

  const notes = (
    <Disclosure label="Add a note" defaultOpen={Boolean(initial?.notes)}>
      <label className="block space-y-2 text-sm font-semibold">
        Notes
        <Textarea name="notes" defaultValue={String(initial?.notes ?? "")} />
      </label>
    </Disclosure>
  );

  return (
    <form action={submit} className="space-y-4">
      {activityId && initial?.updatedAt ? <input type="hidden" name="expectedUpdatedAt" value={String(initial.updatedAt)} /> : null}
      <BabyField babies={babies} defaultBaby={defaultBaby} />
      <TypeFields
        type={type}
        slots={{ initial, editing: Boolean(initial), preferences: unitPreferences, medicineNames, supplementNames, when: whenSection, notes }}
      />

      {/* Cancel and Save share the activity page's bar: FIXED just above the phone's bottom navigation, the
          same height and in the same spot on every form, so the thumb always finds them and they never
          scroll. The page adds bottom padding so the last field stays clear of
          it. An error shows inside the bar, right above the button that caused it, not off-screen. */}
      <div className="fixed inset-x-0 bottom-[4.75rem] z-20 px-3 md:bottom-4 md:left-64 md:px-6">
        <div className="mx-auto max-w-lg space-y-2 rounded-xl border border-border bg-card/95 p-2 shadow-soft backdrop-blur">
          {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Link
              replace={allowActivityDestination}
              href={cancelHref}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-bold text-primary transition hover:bg-muted"
            >
              Cancel
            </Link>
            <Button type="submit" disabled={submitting} aria-live="polite" className="min-h-11 flex-1 text-base">
              {submitting ? (activityId ? "Saving..." : "Logging...") : activityId ? "Save changes" : `Log ${activityLabels[type].toLowerCase()}`}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

/** Calm layout shared by every activity: the key choice, then when, then everything optional folded away. */
function Layout({ slots, main, details, detailsFields = [] }: { slots: Slots; main: ReactNode; details?: ReactNode; detailsFields?: string[] }) {
  return (
    <>
      <div className="space-y-4">{main}</div>
      {slots.when}
      <div className="divide-y divide-border border-t border-border">
        {slots.notes}
        {details ? (
          <Disclosure label="More details" defaultOpen={hasActivityDetail(slots.initial, detailsFields)}>
            {details}
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}

function TypeFields({ type, slots }: { type: ActivityTypeName; slots: Slots }) {
  const { initial } = slots;
  switch (type) {
    case "feeding":
      return <FeedingFields slots={slots} />;
    case "diaper":
      return (
        <Layout
          slots={slots}
          main={
            <>
              <ChoiceInput name="kind" label="Kind" options={["wet", "dirty", "mixed", "dry"]} defaultValue={String(initial?.kind ?? "wet")} />
              <div className="flex flex-wrap gap-2">
                <ToggleChip name="rashConcern" label="Rash or concern" defaultChecked={Boolean(initial?.rashConcern)} />
              </div>
            </>
          }
          details={
            <>
              <div className="flex flex-wrap gap-2">
                <ToggleChip name="blowout" label="Blowout" defaultChecked={Boolean(initial?.blowout)} />
                <ToggleChip name="creamApplied" label="Cream applied" defaultChecked={Boolean(initial?.creamApplied)} />
              </div>
              <InputField name="color" label="Color" defaultValue={initial?.color} />
              <InputField name="consistency" label="Consistency" defaultValue={initial?.consistency} />
              <InputField name="condition" label="Condition" defaultValue={initial?.condition} />
            </>
          }
          detailsFields={["color", "consistency", "condition", "blowout", "creamApplied"]}
        />
      );
    case "sleep":
      return (
        <Layout
          slots={slots}
          main={<ChoiceInput name="sleepType" label="Sleep type" options={["nap", "night"]} defaultValue={String(initial?.sleepType ?? "")} optional />}
          details={
            <>
              <ChoiceInput name="quality" label="Quality" options={["settled", "restless", "woke early"]} defaultValue={String(initial?.quality ?? "")} optional />
              <InputField name="location" label="Location" defaultValue={initial?.location} />
            </>
          }
          detailsFields={["location", "quality"]}
        />
      );
    case "pumping":
      return <PumpingFields slots={slots} />;
    case "medicine":
      return <Layout slots={slots} main={<ItemDoseFields kind="medicine" initial={initial} units={slots.preferences.medicineUnits} names={slots.medicineNames} />} />;
    case "supplement":
      return <Layout slots={slots} main={<ItemDoseFields kind="supplement" initial={initial} units={slots.preferences.supplementUnits} names={slots.supplementNames} />} />;
    case "measurement": {
      const { editing, preferences } = slots;
      return (
        <Layout
          slots={slots}
          main={
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <InputField name="weight" label="Weight" defaultValue={initial?.weight} type="number" inputMode="decimal" min="0" step="any" />
              <InputField name="weightUnit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.weightUnit), preferred: preferences.weight, fallback: "lb" })} />
              <InputField name="length" label="Length/height" defaultValue={initial?.length} type="number" inputMode="decimal" min="0" step="any" />
              <InputField name="lengthUnit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.lengthUnit), preferred: preferences.length, fallback: "in" })} />
            </div>
          }
          details={
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <InputField name="headCircumference" label="Head circumference" defaultValue={initial?.headCircumference} type="number" inputMode="decimal" min="0" step="any" />
              <InputField name="headUnit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.headUnit), preferred: preferences.length, fallback: "in" })} />
              <InputField name="temperature" label="Temperature" defaultValue={initial?.temperature} type="number" inputMode="decimal" min="0" step="any" />
              <InputField name="temperatureUnit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.temperatureUnit), preferred: preferences.temperature, fallback: "F" })} />
              <div className="col-span-2">
                <InputField name="measurementType" label="Measurement type" defaultValue={initial?.measurementType} />
              </div>
            </div>
          }
          detailsFields={["headCircumference", "temperature", "measurementType"]}
        />
      );
    }
    case "milestone":
      return (
        <Layout
          slots={slots}
          main={<InputField name="title" label="Title" defaultValue={initial?.title} required />}
          details={<InputField name="category" label="Category" defaultValue={initial?.category} />}
          detailsFields={["category"]}
        />
      );
    case "note":
      return (
        <Layout
          slots={slots}
          main={
            <label className="block space-y-2 text-sm font-semibold">
              Note
              <Textarea name="text" defaultValue={String(initial?.text ?? "")} required />
            </label>
          }
          details={<InputField name="category" label="Category" defaultValue={initial?.category} />}
          detailsFields={["category"]}
        />
      );
    case "bath":
      return (
        <Layout
          slots={slots}
          main={<InputField name="bathType" label="Bath type" defaultValue={initial?.bathType} />}
          details={
            <>
              <InputField name="products" label="Products" defaultValue={initial?.products} />
              <InputField name="waterTemp" label="Water temp" defaultValue={initial?.waterTemp} />
            </>
          }
          detailsFields={["products", "waterTemp"]}
        />
      );
    case "play":
      return (
        <Layout
          slots={slots}
          main={
            <>
              <ChoiceInput name="intensity" label="Kind of play" options={["quiet", "active", "tummy time", "outside"]} defaultValue={String(initial?.intensity ?? "")} optional />
              <InputField name="activityName" label="Activity" defaultValue={initial?.activityName} />
            </>
          }
          details={<InputField name="location" label="Location" defaultValue={initial?.location} />}
          detailsFields={["location"]}
        />
      );
    case "mood":
      return (
        <Layout
          slots={slots}
          main={
            <>
              <InputField name="mood" label="Mood" defaultValue={initial?.mood} required />
              <ChoiceInput name="intensity" label="Intensity" options={["1", "2", "3", "4", "5"]} defaultValue={String(initial?.intensity ?? "")} optional />
            </>
          }
          details={<InputField name="context" label="Context" defaultValue={initial?.context} />}
          detailsFields={["context"]}
        />
      );
    case "vaccine":
      return (
        <Layout
          slots={slots}
          main={<InputField name="name" label="Vaccine" defaultValue={initial?.name} required />}
          details={
            <>
              <InputField name="dose" label="Dose" defaultValue={initial?.dose} />
              <InputField name="lot" label="Lot" defaultValue={initial?.lot} />
              <InputField name="provider" label="Provider" defaultValue={initial?.provider} />
              <label className="block space-y-2 text-sm font-semibold">
                Due date
                <Input name="dueDate" type="date" defaultValue={String(initial?.dueDate ?? "")} />
              </label>
              <InputField name="documentUrl" label="Document URL" defaultValue={initial?.documentUrl} inputMode="url" />
            </>
          }
          detailsFields={["dose", "lot", "provider", "dueDate", "documentUrl"]}
        />
      );
    case "milk_inventory":
      return <MilkInventoryFields slots={slots} />;
  }
}

function useVolumeUnit(slots: Slots) {
  return useState(() =>
    resolveFormUnit({ editing: slots.editing, saved: textValue(slots.initial?.unit), preferred: slots.preferences.volume, fallback: "oz" })
  );
}

function FeedingFields({ slots }: { slots: Slots }) {
  const { initial } = slots;
  const [mode, setMode] = useState(String(initial?.mode ?? "bottle"));
  const [unit, setUnit] = useVolumeUnit(slots);
  const liquid = mode === "bottle" || mode === "formula";

  return (
    <Layout
      slots={slots}
      main={
        <>
          <ChoiceField name="mode" label="Kind" options={["breast", "bottle", "formula", "solids"]} value={mode} onChange={setMode} />
          {liquid || hasActivityDetail(initial, ["amount"]) ? <AmountStepper name="amount" label="Amount" defaultValue={initial?.amount} unit={unit} /> : null}
          {mode === "breast" || hasActivityDetail(initial, ["side"]) ? (
            <ChoiceInput name="side" label="Side" options={["left", "right", "both"]} defaultValue={String(initial?.side ?? "")} optional />
          ) : null}
          {mode === "solids" || hasActivityDetail(initial, ["food"]) ? <InputField name="food" label="Food" defaultValue={initial?.food} /> : null}
        </>
      }
      details={
        <>
          <UnitChoice value={unit} onChange={setUnit} />
          {liquid || hasActivityDetail(initial, ["bottleType"]) ? <InputField name="bottleType" label="Bottle type" defaultValue={initial?.bottleType} /> : null}
          {mode === "breast" || hasActivityDetail(initial, ["leftSeconds", "rightSeconds"]) ? (
            <div className="grid grid-cols-2 gap-3">
              <InputField name="leftSeconds" label="Left seconds" defaultValue={initial?.leftSeconds} type="number" inputMode="numeric" min="0" step="1" />
              <InputField name="rightSeconds" label="Right seconds" defaultValue={initial?.rightSeconds} type="number" inputMode="numeric" min="0" step="1" />
            </div>
          ) : null}
        </>
      }
      detailsFields={["bottleType", "leftSeconds", "rightSeconds"]}
    />
  );
}

function PumpingFields({ slots }: { slots: Slots }) {
  const { initial } = slots;
  const [unit, setUnit] = useVolumeUnit(slots);
  return (
    <Layout
      slots={slots}
      main={<AmountStepper name="amount" label="Total amount" defaultValue={initial?.amount} unit={unit} />}
      details={
        <>
          <UnitChoice value={unit} onChange={setUnit} />
          <AmountStepper name="leftAmount" label="Left amount" defaultValue={initial?.leftAmount} unit={unit} />
          <AmountStepper name="rightAmount" label="Right amount" defaultValue={initial?.rightAmount} unit={unit} />
          <ChoiceInput
            name="inventoryAction"
            label="Milk went to"
            options={["stored", "fed", "discarded", "thawed", "donated", "expired"]}
            defaultValue={String(initial?.inventoryAction ?? "")}
            optional
          />
        </>
      }
      detailsFields={["leftAmount", "rightAmount", "inventoryAction"]}
    />
  );
}

function MilkInventoryFields({ slots }: { slots: Slots }) {
  const { initial } = slots;
  const [unit, setUnit] = useVolumeUnit(slots);
  return (
    <Layout
      slots={slots}
      main={
        <>
          <ChoiceInput name="action" label="Action" options={["stored", "fed", "discarded", "thawed", "donated", "expired"]} defaultValue={String(initial?.action ?? "stored")} />
          <AmountStepper name="amount" label="Amount" defaultValue={initial?.amount} unit={unit} />
        </>
      }
      details={
        <>
          <UnitChoice value={unit} onChange={setUnit} />
          <InputField name="storage" label="Storage" defaultValue={initial?.storage} />
          <InputField name="label" label="Label" defaultValue={initial?.label} />
        </>
      }
      detailsFields={["storage", "label"]}
    />
  );
}

function ItemDoseFields({
  kind,
  initial,
  units,
  names
}: {
  kind: "medicine" | "supplement";
  initial?: Initial;
  units: Record<string, string>;
  names: string[];
}) {
  const initialName = textValue(initial?.name) ?? "";
  const savedUnit = textValue(initial?.unit);
  const editing = Boolean(initial);
  const [name, setName] = useState(initialName);
  const [unit, setUnit] = useState(() => resolveItemDoseUnit({ saved: savedUnit, name: initialName, units: editing ? {} : units }));
  const [unitEdited, setUnitEdited] = useState(editing || Boolean(savedUnit));
  const label = kind === "medicine" ? "Medicine" : "Supplement";

  return (
    <div className="grid grid-cols-[1fr_6rem] gap-3">
      <label className="col-span-2 block space-y-2 text-sm font-semibold">
        {label}
        <Input
          name="name"
          value={name}
          list={`${kind}-names`}
          required
          onChange={(event) => {
            const nextName = event.target.value;
            setName(nextName);
            if (!unitEdited) setUnit(resolveItemDoseUnit({ name: nextName, units }));
          }}
        />
        <datalist id={`${kind}-names`}>
          {names.map((itemName) => <option key={itemName} value={itemName} />)}
        </datalist>
      </label>
      <InputField name="dose" label="Dose" defaultValue={initial?.dose} type="number" inputMode="decimal" min="0" step="any" />
      <label className="block space-y-2 text-sm font-semibold">
        Unit
        <Input
          name="unit"
          value={unit}
          maxLength={20}
          onChange={(event) => {
            setUnit(event.target.value);
            setUnitEdited(true);
          }}
        />
      </label>
    </div>
  );
}

function BabyField({ babies, defaultBaby }: { babies: BabyOption[]; defaultBaby: string }) {
  const [babyId, setBabyId] = useState(defaultBaby);
  if (babies.length <= 1) return <input type="hidden" name="babyId" value={defaultBaby} />;
  return (
    <ChoiceField
      name="babyId"
      label="Baby"
      options={babies.map((baby) => baby.id)}
      labels={Object.fromEntries(babies.map((baby) => [baby.id, baby.name]))}
      value={babyId}
      onChange={setBabyId}
    />
  );
}

const lengthPresets = [5, 10, 15, 20, 30, 45, 60];
const pill = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border px-3 text-sm font-semibold transition-colors";
const pillOn = "border-primary bg-primary text-primary-foreground";
const pillOff = "border-border bg-card hover:bg-muted";

function LengthField({ minutes, onChange, start }: { minutes: number | null; onChange: (minutes: number | null) => void; start: string }) {
  const custom = minutes !== null && !lengthPresets.includes(minutes);
  const [showCustom, setShowCustom] = useState(custom);

  return (
    <div role="group" aria-label="How long" className="space-y-2">
      <p className="text-sm font-semibold">
        How long <span className="font-normal text-muted-foreground">(optional)</span>
      </p>
      <div className={scrollRow}>
        {lengthPresets.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={minutes === preset}
            onClick={() => {
              setShowCustom(false);
              onChange(minutes === preset ? null : preset);
            }}
            className={cn(pill, minutes === preset ? pillOn : pillOff)}
          >
            {formatMinutes(preset)}
          </button>
        ))}
        <button type="button" aria-pressed={showCustom} onClick={() => setShowCustom(!showCustom)} className={cn(pill, showCustom ? pillOn : pillOff)}>
          Other
        </button>
      </div>
      {showCustom ? (
        <label className="flex items-center gap-2 text-sm font-semibold">
          Minutes
          <Input
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={custom ? String(minutes) : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              onChange(Number.isInteger(next) && next > 0 ? next : null);
            }}
            className="w-28"
          />
        </label>
      ) : null}
      {minutes ? (
        <p className="text-xs font-semibold text-muted-foreground" aria-live="polite">
          Ends {formatClock(addMinutes(start, minutes))} · {formatMinutes(minutes)}
        </p>
      ) : null}
    </div>
  );
}

/** Oz steps by half an ounce; mL by 5, so both units move by a similar, useful amount. */
function AmountStepper({ name, label, defaultValue, unit }: { name: string; label: string; defaultValue?: unknown; unit: string }) {
  const id = useId();
  const [value, setValue] = useState(defaultValue === null || defaultValue === undefined ? "" : String(defaultValue));
  const step = normalizeVolumeUnit(unit) === "mL" ? 5 : 0.5;
  const current = Number.parseFloat(value);

  function bump(direction: 1 | -1) {
    const base = Number.isFinite(current) ? current : 0;
    const next = Math.max(0, Math.round((base + direction * step) / step) * step);
    setValue(String(Number(next.toFixed(2))));
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <div className="grid grid-cols-[3rem_1fr_3rem] gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()} by ${step}`}
          disabled={!Number.isFinite(current) || current <= 0}
          onClick={() => bump(-1)}
          className="grid min-h-12 place-items-center rounded-lg border border-border bg-muted transition-colors hover:bg-border disabled:opacity-40"
        >
          <Minus aria-hidden="true" className="h-5 w-5" />
        </button>
        <div className="flex min-h-12 items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 focus-within:border-ring focus-within:ring-4 focus-within:ring-ring/20">
          <input
            id={id}
            name={name}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            onChange={(event) => {
              if (/^\d*\.?\d*$/.test(event.target.value)) setValue(event.target.value);
            }}
            className="w-20 min-w-0 bg-transparent text-right text-2xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/50"
          />
          {unit ? <span className="w-12 text-left text-base font-semibold text-muted-foreground">{unit}</span> : null}
        </div>
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()} by ${step}`}
          onClick={() => bump(1)}
          className="grid min-h-12 place-items-center rounded-lg border border-border bg-muted transition-colors hover:bg-border"
        >
          <Plus aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function UnitChoice({ value, onChange }: { value: string; onChange: (unit: string) => void }) {
  return <ChoiceField name="unit" label="Unit for this entry" options={["oz", "mL"]} labels={{ oz: "oz", mL: "mL" }} value={value} onChange={onChange} optional />;
}

/** Segmented single choice. Submits exactly like the select it replaces: one named value, "" when an optional choice is cleared. */
function ChoiceField({
  name,
  label,
  options,
  value,
  onChange,
  optional = false,
  labels
}: {
  name: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  labels?: Record<string, string>;
}) {
  const labelId = useId();
  const list = value && !options.includes(value) ? [...options, value] : options;
  const columns = list.length <= 4 ? list.length : 3;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const index = (Math.max(0, list.indexOf(value)) + delta + list.length) % list.length;
    onChange(list[index]);
    event.currentTarget.querySelectorAll<HTMLElement>("[role='radio']")[index]?.focus();
  }

  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm font-semibold">
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={handleKeyDown}
        className="grid gap-1 rounded-xl bg-muted p-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {list.map((option, index) => {
          const checked = option === value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (!list.includes(value) && index === 0) ? 0 : -1}
              onClick={() => onChange(optional && checked ? "" : option)}
              className={cn(
                "min-h-11 rounded-lg px-2 text-sm leading-tight transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/30",
                checked ? "bg-card font-semibold text-foreground shadow-sm ring-2 ring-primary" : "font-semibold text-muted-foreground hover:text-foreground"
              )}
            >
              {labels?.[option] ?? displayLabel(option)}
            </button>
          );
        })}
      </div>
      <input type="hidden" name={name} value={value} />
    </div>
  );
}

function ChoiceInput({ defaultValue, ...props }: Omit<Parameters<typeof ChoiceField>[0], "value" | "onChange"> & { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  return <ChoiceField {...props} value={value} onChange={setValue} />;
}

function ToggleChip({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-border bg-card px-4 text-sm font-semibold transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-ring/30">
      <input name={name} type="checkbox" defaultChecked={defaultChecked} className="sr-only" />
      {label}
    </label>
  );
}

function Disclosure({ label, defaultOpen = false, children }: { label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm font-semibold marker:hidden [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-muted">
          <Plus className="h-3.5 w-3.5 transition-transform group-open:rotate-45" />
        </span>
        {label}
      </summary>
      <div className="grid gap-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function activityIdField(initial?: Record<string, unknown>) {
  return Boolean(initial?.id);
}

function InputField({
  name,
  label,
  defaultValue,
  required,
  type,
  inputMode,
  min,
  max,
  step,
  placeholder
}: {
  name: string;
  label: string;
  defaultValue?: unknown;
  required?: boolean;
  type?: InputHTMLAttributes<HTMLInputElement>["type"];
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  min?: InputHTMLAttributes<HTMLInputElement>["min"];
  max?: InputHTMLAttributes<HTMLInputElement>["max"];
  step?: InputHTMLAttributes<HTMLInputElement>["step"];
  placeholder?: string;
}) {
  return (
    <label className="block space-y-2 text-sm font-semibold">
      {label}
      <Input
        name={name}
        defaultValue={String(defaultValue ?? "")}
        required={required}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
      />
    </label>
  );
}
