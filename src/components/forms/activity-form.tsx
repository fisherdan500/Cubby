"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import type { ActivityTypeName } from "@/domain/activity";

type BabyOption = { id: string; name: string; timezone: string };

export function ActivityForm({
  babies,
  type,
  initial,
  activityId
}: {
  babies: BabyOption[];
  type: ActivityTypeName;
  initial?: Record<string, string | number | boolean | null | undefined>;
  activityId?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const defaultBaby = String(initial?.babyId ?? babies[0]?.id ?? "");

  async function submit(formData: FormData) {
    setError("");
    const body = Object.fromEntries(formData);
    body.type = type;
    body.timezone = String(body.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
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
    router.push("/app");
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
      <Input name="timezone" type="hidden" defaultValue={String(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)} />
      <label className="block space-y-2 text-sm font-semibold">
        Time
        <Input name="occurredAt" type="datetime-local" defaultValue={String(initial?.occurredAt ?? localDateTimeValue())} required />
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

function localDateTimeValue(date?: Date) {
  const value = date ?? new Date();
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function timeRangeFields(type: ActivityTypeName, initial?: Record<string, unknown>) {
  if (!["feeding", "sleep", "pumping"].includes(type)) return null;
  return (
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
        </div>
      );
    case "diaper":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select name="kind" label="Kind" defaultValue={String(initial?.kind ?? "wet")} options={["wet", "dirty", "mixed", "dry"]} />
          <InputField name="color" label="Color" defaultValue={initial?.color} />
          <InputField name="consistency" label="Consistency" defaultValue={initial?.consistency} />
          <label className="flex items-center gap-2 pt-7 text-sm font-semibold">
            <input name="rashConcern" type="checkbox" defaultChecked={Boolean(initial?.rashConcern)} />
            Rash or concern
          </label>
        </div>
      );
    case "sleep":
      return activityIdField(initial) ? null : (
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input name="activeTimer" type="checkbox" />
          Start active sleep timer
        </label>
      );
    case "pumping":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField name="amount" label="Total amount" defaultValue={initial?.amount} />
          <InputField name="leftAmount" label="Left amount" defaultValue={initial?.leftAmount} />
          <InputField name="rightAmount" label="Right amount" defaultValue={initial?.rightAmount} />
          <InputField name="unit" label="Unit" defaultValue={initial?.unit ?? "oz"} />
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
