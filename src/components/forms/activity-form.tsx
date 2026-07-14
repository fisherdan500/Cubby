"use client";

import Link from "next/link";
import type { InputHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActivityArtwork } from "@/components/activity-artwork";
import { Input, Textarea } from "@/components/ui/input";
import { activityLabels, timerActivityTypes, type ActivityTypeName } from "@/domain/activity";
import type { UnitPreferences } from "@/domain/unit-preferences";
import {
  activityFormCancelHref,
  activityFormSuccessHref,
  hasActivityDetail,
  resolveFormUnit,
  resolveItemDoseUnit
} from "@/lib/activity-form";
import { displayLabel } from "@/lib/display-label";
import { dateTimeInputValue } from "@/lib/timezone";

type BabyOption = { id: string; name: string };

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
  initial?: Record<string, string | number | boolean | null | undefined>;
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

  async function submit(formData: FormData) {
    setError("");
    setSubmitting(true);
    try {
      const body = Object.fromEntries(formData);
      body.type = type;
      const response = await fetch(activityId ? `/api/activities/${activityId}` : "/api/activities", {
        method: activityId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !result?.ok) {
        setError(result && !result.ok ? result.error?.message ?? "Could not save this activity." : "Could not save this activity.");
        return;
      }
      const destination = activityFormSuccessHref({
        successTo,
        babyId: String(body.babyId || defaultBaby),
        returnDate,
        allowActivityDestination
      });
      if (allowActivityDestination) router.replace(destination);
      else router.push(destination);
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={submit} className="space-y-4 pb-20 md:pb-0">
      {activityId && initial?.updatedAt ? <input type="hidden" name="expectedUpdatedAt" value={String(initial.updatedAt)} /> : null}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-soft p-3">
        <ActivityArtwork type={type} size="lg" />
        <div className="min-w-0">
          <p className="font-editorial text-lg font-bold">{activityId ? "Update" : "New"} {activityLabels[type].toLowerCase()}</p>
          <p className="text-sm text-muted-foreground">Record the essentials now. Optional details can stay blank.</p>
        </div>
      </div>
      <FormSection title="When">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm font-semibold">
            Baby
            <select name="babyId" defaultValue={defaultBaby} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2">
              {babies.map((baby) => (
                <option key={baby.id} value={baby.id}>
                  {baby.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2 text-sm font-semibold">
            Time
            <Input name="occurredAt" type="datetime-local" defaultValue={String(initial?.occurredAt ?? localDateTimeValue(undefined, appTimeZone))} required />
          </label>
        </div>
        {timeRangeFields(type, initial)}
      </FormSection>

      <FormSection title="Details">{typeFields(type, initial, unitPreferences, medicineNames, supplementNames)}</FormSection>

      <FormSection title="Notes">
        <label className="block space-y-2 text-sm font-semibold">
          Notes
          <Textarea name="notes" defaultValue={String(initial?.notes ?? "")} />
        </label>
      </FormSection>

      {error ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <div className="sticky bottom-20 z-20 -mx-4 border-t border-border bg-card/95 p-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        <div className="grid grid-cols-2 gap-2 md:flex md:justify-end">
          <Link
            replace={allowActivityDestination}
            href={cancelHref}
            className="inline-flex min-h-12 items-center justify-center rounded-lg bg-muted px-4 py-2 text-base font-semibold text-foreground transition hover:bg-border md:min-w-32"
          >
            Cancel
          </Link>
          <Button type="submit" disabled={submitting} aria-live="polite" className="min-h-12 w-full text-base md:w-auto md:min-w-44">
            {submitting ? (activityId ? "Saving..." : "Logging...") : activityId ? "Save changes" : "Log activity"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b border-border pb-4 last:border-0">
      <h2 className="text-sm font-black text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function localDateTimeValue(date: Date | undefined, timeZone: string) {
  return dateTimeInputValue(date, timeZone);
}

function timeRangeFields(type: ActivityTypeName, initial?: Record<string, unknown>) {
  if (!timerActivityTypes.includes(type as (typeof timerActivityTypes)[number])) return null;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-2 text-sm font-semibold">
          Start
          <Input name="startedAt" type="datetime-local" defaultValue={String(initial?.startedAt ?? "")} />
        </label>
        <label className="block space-y-2 text-sm font-semibold">
          End
          <Input name="endedAt" type="datetime-local" defaultValue={String(initial?.endedAt ?? "")} />
        </label>
      </div>
      {!activityIdField(initial) ? (
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input name="activeTimer" type="checkbox" />
          Start active timer
        </label>
      ) : null}
    </div>
  );
}

function typeFields(
  type: ActivityTypeName,
  initial: Record<string, string | number | boolean | null | undefined> | undefined,
  preferences: UnitPreferences,
  medicineNames: string[],
  supplementNames: string[]
) {
  const editing = Boolean(initial);
  switch (type) {
    case "feeding":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="mode" label="Kind" defaultValue={String(initial?.mode ?? "bottle")} options={["breast", "bottle", "formula", "solids"]} />
            <InputField name="amount" label="Amount" defaultValue={initial?.amount} type="number" inputMode="decimal" min="0" step="any" />
            <Select name="side" label="Side" defaultValue={String(initial?.side ?? "")} options={["", "left", "right", "both"]} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["unit", "bottleType", "food", "leftSeconds", "rightSeconds"])}>
            <InputField name="unit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.unit), preferred: preferences.volume, fallback: "oz" })} />
            <InputField name="bottleType" label="Bottle type" defaultValue={initial?.bottleType} />
            <InputField name="food" label="Solids food" defaultValue={initial?.food} />
            <InputField name="leftSeconds" label="Left seconds" defaultValue={initial?.leftSeconds} type="number" inputMode="numeric" min="0" step="1" />
            <InputField name="rightSeconds" label="Right seconds" defaultValue={initial?.rightSeconds} type="number" inputMode="numeric" min="0" step="1" />
          </OptionalDetails>
        </div>
      );
    case "diaper":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="kind" label="Kind" defaultValue={String(initial?.kind ?? "wet")} options={["wet", "dirty", "mixed", "dry"]} />
            <label className="flex items-center gap-2 pt-2 text-sm font-semibold sm:pt-7">
              <input name="rashConcern" type="checkbox" defaultChecked={Boolean(initial?.rashConcern)} />
              Rash or concern
            </label>
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["color", "consistency", "condition", "blowout", "creamApplied"])}>
            <InputField name="color" label="Color" defaultValue={initial?.color} />
            <InputField name="consistency" label="Consistency" defaultValue={initial?.consistency} />
            <InputField name="condition" label="Condition" defaultValue={initial?.condition} />
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input name="blowout" type="checkbox" defaultChecked={Boolean(initial?.blowout)} />
              Blowout
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input name="creamApplied" type="checkbox" defaultChecked={Boolean(initial?.creamApplied)} />
              Cream applied
            </label>
          </OptionalDetails>
        </div>
      );
    case "sleep":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="sleepType" label="Sleep type" defaultValue={String(initial?.sleepType ?? "")} options={["", "nap", "night"]} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["location", "quality"])}>
            <InputField name="location" label="Location" defaultValue={initial?.location} />
            <Select name="quality" label="Quality" defaultValue={String(initial?.quality ?? "")} options={["", "settled", "restless", "woke early"]} />
          </OptionalDetails>
        </div>
      );
    case "pumping":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <InputField name="amount" label="Total amount" defaultValue={initial?.amount} type="number" inputMode="decimal" min="0" step="any" />
            <InputField name="unit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.unit), preferred: preferences.volume, fallback: "oz" })} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["leftAmount", "rightAmount", "inventoryAction"])}>
            <InputField name="leftAmount" label="Left amount" defaultValue={initial?.leftAmount} type="number" inputMode="decimal" min="0" step="any" />
            <InputField name="rightAmount" label="Right amount" defaultValue={initial?.rightAmount} type="number" inputMode="decimal" min="0" step="any" />
            <Select
              name="inventoryAction"
              label="Inventory action"
              defaultValue={String(initial?.inventoryAction ?? "")}
              options={["", "stored", "fed", "discarded", "thawed", "donated", "expired"]}
            />
          </OptionalDetails>
        </div>
      );
    case "medicine":
      return <ItemDoseFields kind="medicine" initial={initial} units={preferences.medicineUnits} names={medicineNames} />;
    case "measurement":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="weight" label="Weight" defaultValue={initial?.weight} type="number" inputMode="decimal" min="0" step="any" />
          <InputField name="weightUnit" label="Weight unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.weightUnit), preferred: preferences.weight, fallback: "lb" })} />
          <InputField name="length" label="Length/height" defaultValue={initial?.length} type="number" inputMode="decimal" min="0" step="any" />
          <InputField name="lengthUnit" label="Length unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.lengthUnit), preferred: preferences.length, fallback: "in" })} />
          <InputField name="headCircumference" label="Head circumference" defaultValue={initial?.headCircumference} type="number" inputMode="decimal" min="0" step="any" />
          <InputField name="headUnit" label="Head unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.headUnit), preferred: preferences.length, fallback: "in" })} />
          <InputField name="temperature" label="Temperature" defaultValue={initial?.temperature} type="number" inputMode="decimal" min="0" step="any" />
          <InputField name="temperatureUnit" label="Temperature unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.temperatureUnit), preferred: preferences.temperature, fallback: "F" })} />
          <InputField name="measurementType" label="Measurement type" defaultValue={initial?.measurementType} />
        </div>
      );
    case "milestone":
      return (
        <div className="space-y-3">
          <InputField name="title" label="Title" defaultValue={initial?.title} required />
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["category"])}>
            <InputField name="category" label="Category" defaultValue={initial?.category} />
          </OptionalDetails>
        </div>
      );
    case "note":
      return (
        <div className="space-y-3">
          <label className="block space-y-2 text-sm font-semibold">
            Note
            <Textarea name="text" defaultValue={String(initial?.text ?? "")} required />
          </label>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["category"])}>
            <InputField name="category" label="Category" defaultValue={initial?.category} />
          </OptionalDetails>
        </div>
      );
    case "bath":
      return (
        <div className="space-y-3">
          <InputField name="bathType" label="Bath type" defaultValue={initial?.bathType} />
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["products", "waterTemp"])}>
            <InputField name="products" label="Products" defaultValue={initial?.products} />
            <InputField name="waterTemp" label="Water temp" defaultValue={initial?.waterTemp} />
          </OptionalDetails>
        </div>
      );
    case "play":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <InputField name="activityName" label="Activity" defaultValue={initial?.activityName} />
            <Select name="intensity" label="Intensity" defaultValue={String(initial?.intensity ?? "")} options={["", "quiet", "active", "tummy time", "outside"]} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["location"])}>
            <InputField name="location" label="Location" defaultValue={initial?.location} />
          </OptionalDetails>
        </div>
      );
    case "mood":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <InputField name="mood" label="Mood" defaultValue={initial?.mood} required />
            <Select name="intensity" label="Intensity" defaultValue={String(initial?.intensity ?? "")} options={["", "1", "2", "3", "4", "5"]} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["context"])}>
            <InputField name="context" label="Context" defaultValue={initial?.context} />
          </OptionalDetails>
        </div>
      );
    case "supplement":
      return <ItemDoseFields kind="supplement" initial={initial} units={preferences.supplementUnits} names={supplementNames} />;
    case "vaccine":
      return (
        <div className="space-y-3">
          <InputField name="name" label="Vaccine" defaultValue={initial?.name} required />
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["dose", "lot", "provider", "dueDate", "documentUrl"])}>
            <InputField name="dose" label="Dose" defaultValue={initial?.dose} />
            <InputField name="lot" label="Lot" defaultValue={initial?.lot} />
            <InputField name="provider" label="Provider" defaultValue={initial?.provider} />
            <label className="block space-y-2 text-sm font-semibold">
              Due date
              <Input name="dueDate" type="date" defaultValue={String(initial?.dueDate ?? "")} />
            </label>
            <InputField name="documentUrl" label="Document URL" defaultValue={initial?.documentUrl} inputMode="url" />
          </OptionalDetails>
        </div>
      );
    case "milk_inventory":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              name="action"
              label="Action"
              defaultValue={String(initial?.action ?? "stored")}
              options={["stored", "fed", "discarded", "thawed", "donated", "expired"]}
            />
            <InputField name="amount" label="Amount" defaultValue={initial?.amount} type="number" inputMode="decimal" min="0" step="any" />
            <InputField name="unit" label="Unit" defaultValue={resolveFormUnit({ editing, saved: textValue(initial?.unit), preferred: preferences.volume, fallback: "oz" })} />
          </div>
          <OptionalDetails defaultOpen={hasActivityDetail(initial, ["storage", "label"])}>
            <InputField name="storage" label="Storage" defaultValue={initial?.storage} />
            <InputField name="label" label="Label" defaultValue={initial?.label} />
          </OptionalDetails>
        </div>
      );
  }
}

function ItemDoseFields({
  kind,
  initial,
  units,
  names
}: {
  kind: "medicine" | "supplement";
  initial?: Record<string, string | number | boolean | null | undefined>;
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
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-2 text-sm font-semibold">
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

function Select({
  name,
  label,
  defaultValue,
  options
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <label className="block space-y-2 text-sm font-semibold">
      {label}
      <select name={name} defaultValue={defaultValue} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2">
        {options.map((option) => (
          <option key={option || "none"} value={option}>
            {displayLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function OptionalDetails({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-lg border border-border bg-surface-soft/60"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-semibold marker:hidden">
        More details
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-2">{children}</div>
    </details>
  );
}
