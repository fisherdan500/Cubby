"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { timerActivityTypes, type ActivityTypeName } from "@/domain/activity";
import { dateTimeInputValue } from "@/lib/timezone";

type BabyOption = { id: string; name: string };

export function ActivityForm({
  babies,
  type,
  initial,
  activityId,
  selectedBabyId,
  returnDate,
  appTimeZone
}: {
  babies: BabyOption[];
  type: ActivityTypeName;
  initial?: Record<string, string | number | boolean | null | undefined>;
  activityId?: string;
  selectedBabyId?: string;
  returnDate?: string;
  appTimeZone: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const requestedBaby = String(initial?.babyId ?? selectedBabyId ?? "");
  const defaultBaby = babies.some((baby) => baby.id === requestedBaby) ? requestedBaby : String(babies[0]?.id ?? "");

  async function submit(formData: FormData) {
    setError("");
    const body = Object.fromEntries(formData);
    body.type = type;
    const response = await fetch(activityId ? `/api/activities/${activityId}` : "/api/activities", {
      method: activityId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const query = new URLSearchParams({ babyId: String(body.babyId || defaultBaby) });
    if (returnDate) query.set("date", returnDate);
    router.push(`/app?${query.toString()}`);
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-4">
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
      {timeRangeFields(type, initial)}
      {typeFields(type, initial)}
      <label className="block space-y-2 text-sm font-semibold">
        Notes
        <Textarea name="notes" defaultValue={String(initial?.notes ?? "")} />
      </label>
      {error ? <p className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button className="w-full">{activityId ? "Save changes" : "Log activity"}</Button>
    </form>
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

function typeFields(type: ActivityTypeName, initial?: Record<string, string | number | boolean | null | undefined>) {
  switch (type) {
    case "feeding":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select name="mode" label="Kind" defaultValue={String(initial?.mode ?? "bottle")} options={["breast", "bottle", "formula", "solids"]} />
          <InputField name="amount" label="Amount" defaultValue={initial?.amount} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit ?? "oz"} />
          <Select name="side" label="Side" defaultValue={String(initial?.side ?? "")} options={["", "left", "right", "both"]} />
          <InputField name="bottleType" label="Bottle type" defaultValue={initial?.bottleType} />
          <InputField name="food" label="Solids food" defaultValue={initial?.food} />
          <InputField name="leftSeconds" label="Left seconds" defaultValue={initial?.leftSeconds} />
          <InputField name="rightSeconds" label="Right seconds" defaultValue={initial?.rightSeconds} />
        </div>
      );
    case "diaper":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select name="kind" label="Kind" defaultValue={String(initial?.kind ?? "wet")} options={["wet", "dirty", "mixed", "dry"]} />
          <InputField name="color" label="Color" defaultValue={initial?.color} />
          <InputField name="consistency" label="Consistency" defaultValue={initial?.consistency} />
          <InputField name="condition" label="Condition" defaultValue={initial?.condition} />
          <label className="flex items-center gap-2 pt-7 text-sm font-semibold">
            <input name="rashConcern" type="checkbox" defaultChecked={Boolean(initial?.rashConcern)} />
            Rash or concern
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input name="blowout" type="checkbox" defaultChecked={Boolean(initial?.blowout)} />
            Blowout
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input name="creamApplied" type="checkbox" defaultChecked={Boolean(initial?.creamApplied)} />
            Cream applied
          </label>
        </div>
      );
    case "sleep":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Select name="sleepType" label="Sleep type" defaultValue={String(initial?.sleepType ?? "")} options={["", "nap", "night"]} />
          <InputField name="location" label="Location" defaultValue={initial?.location} />
          <Select name="quality" label="Quality" defaultValue={String(initial?.quality ?? "")} options={["", "settled", "restless", "woke early"]} />
        </div>
      );
    case "pumping":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="amount" label="Total amount" defaultValue={initial?.amount} />
          <InputField name="leftAmount" label="Left amount" defaultValue={initial?.leftAmount} />
          <InputField name="rightAmount" label="Right amount" defaultValue={initial?.rightAmount} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit ?? "oz"} />
          <Select
            name="inventoryAction"
            label="Inventory action"
            defaultValue={String(initial?.inventoryAction ?? "")}
            options={["", "stored", "fed", "discarded", "thawed", "donated", "expired"]}
          />
        </div>
      );
    case "medicine":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="name" label="Medicine" defaultValue={initial?.name} required />
          <InputField name="dose" label="Dose" defaultValue={initial?.dose} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit} />
        </div>
      );
    case "measurement":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="weight" label="Weight" defaultValue={initial?.weight} />
          <InputField name="weightUnit" label="Weight unit" defaultValue={initial?.weightUnit ?? "lb"} />
          <InputField name="length" label="Length/height" defaultValue={initial?.length} />
          <InputField name="lengthUnit" label="Length unit" defaultValue={initial?.lengthUnit ?? "in"} />
          <InputField name="headCircumference" label="Head circumference" defaultValue={initial?.headCircumference} />
          <InputField name="headUnit" label="Head unit" defaultValue={initial?.headUnit ?? "in"} />
          <InputField name="temperature" label="Temperature" defaultValue={initial?.temperature} />
          <InputField name="temperatureUnit" label="Temperature unit" defaultValue={initial?.temperatureUnit ?? "F"} />
          <InputField name="measurementType" label="Measurement type" defaultValue={initial?.measurementType} />
        </div>
      );
    case "milestone":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="title" label="Title" defaultValue={initial?.title} required />
          <InputField name="category" label="Category" defaultValue={initial?.category} />
        </div>
      );
    case "note":
      return (
        <div className="space-y-3">
          <InputField name="category" label="Category" defaultValue={initial?.category} />
          <label className="block space-y-2 text-sm font-semibold">
            Note
            <Textarea name="text" defaultValue={String(initial?.text ?? "")} required />
          </label>
        </div>
      );
    case "bath":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <InputField name="bathType" label="Bath type" defaultValue={initial?.bathType} />
          <InputField name="products" label="Products" defaultValue={initial?.products} />
          <InputField name="waterTemp" label="Water temp" defaultValue={initial?.waterTemp} />
        </div>
      );
    case "play":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <InputField name="activityName" label="Activity" defaultValue={initial?.activityName} />
          <InputField name="location" label="Location" defaultValue={initial?.location} />
          <Select name="intensity" label="Intensity" defaultValue={String(initial?.intensity ?? "")} options={["", "quiet", "active", "tummy time", "outside"]} />
        </div>
      );
    case "mood":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <InputField name="mood" label="Mood" defaultValue={initial?.mood} required />
          <Select name="intensity" label="Intensity" defaultValue={String(initial?.intensity ?? "")} options={["", "1", "2", "3", "4", "5"]} />
          <InputField name="context" label="Context" defaultValue={initial?.context} />
        </div>
      );
    case "supplement":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="name" label="Supplement" defaultValue={initial?.name} required />
          <InputField name="dose" label="Dose" defaultValue={initial?.dose} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit} />
        </div>
      );
    case "vaccine":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="name" label="Vaccine" defaultValue={initial?.name} required />
          <InputField name="dose" label="Dose" defaultValue={initial?.dose} />
          <InputField name="lot" label="Lot" defaultValue={initial?.lot} />
          <InputField name="provider" label="Provider" defaultValue={initial?.provider} />
          <label className="block space-y-2 text-sm font-semibold">
            Due date
            <Input name="dueDate" type="date" defaultValue={String(initial?.dueDate ?? "")} />
          </label>
          <InputField name="documentUrl" label="Document URL" defaultValue={initial?.documentUrl} />
        </div>
      );
    case "milk_inventory":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            name="action"
            label="Action"
            defaultValue={String(initial?.action ?? "stored")}
            options={["stored", "fed", "discarded", "thawed", "donated", "expired"]}
          />
          <InputField name="amount" label="Amount" defaultValue={initial?.amount} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit ?? "oz"} />
          <InputField name="storage" label="Storage" defaultValue={initial?.storage} />
          <InputField name="label" label="Label" defaultValue={initial?.label} />
        </div>
      );
  }
}

function activityIdField(initial?: Record<string, unknown>) {
  return Boolean(initial?.id);
}

function InputField({
  name,
  label,
  defaultValue,
  required
}: {
  name: string;
  label: string;
  defaultValue?: unknown;
  required?: boolean;
}) {
  return (
    <label className="block space-y-2 text-sm font-semibold">
      {label}
      <Input name={name} defaultValue={String(defaultValue ?? "")} required={required} />
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
            {option || "None"}
          </option>
        ))}
      </select>
    </label>
  );
}
