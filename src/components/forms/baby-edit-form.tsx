"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

export type EditableBaby = {
  id: string;
  name: string;
  birthDate: string | null;
  notes: string | null;
  feedingWarningMinutes: number | null;
  diaperWarningMinutes: number | null;
  sleepWarningMinutes: number | null;
};

/** Only the fields that changed are sent, so two people editing different details do not collide. */
function changedFields(form: FormData, baby: EditableBaby) {
  const next: Record<string, string> = {};
  const name = String(form.get("name") ?? "").trim();
  if (name && name !== baby.name) next.name = name;
  const birthDate = String(form.get("birthDate") ?? "");
  if (birthDate !== (baby.birthDate ?? "")) next.birthDate = birthDate;
  const notes = String(form.get("notes") ?? "").trim();
  if (notes !== (baby.notes ?? "")) next.notes = notes;
  for (const [field, current] of [
    ["feedingWarningMinutes", baby.feedingWarningMinutes],
    ["diaperWarningMinutes", baby.diaperWarningMinutes],
    ["sleepWarningMinutes", baby.sleepWarningMinutes]
  ] as const) {
    const value = String(form.get(field) ?? "").trim();
    if (value !== (current === null ? "" : String(current))) next[field] = value;
  }
  return next;
}

export function BabyEditForm({ baby }: { baby: EditableBaby }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function onSubmit(formData: FormData) {
    setError("");
    setSaved(false);
    const changed = changedFields(formData, baby);
    if (Object.keys(changed).length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/babies/${baby.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changed)
      });
      const result = await response.json().catch(() => null) as
        | { ok: true }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !result?.ok) {
        setError(result && !result.ok ? result.error?.message ?? "Could not save these details." : "Could not save these details.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form action={onSubmit} className="space-y-3">
      <div>
        <label className="text-sm font-bold" htmlFor={`edit-name-${baby.id}`}>Name</label>
        <Input id={`edit-name-${baby.id}`} name="name" defaultValue={baby.name} required />
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor={`edit-birth-${baby.id}`}>Birth date</label>
        <Input id={`edit-birth-${baby.id}`} name="birthDate" type="date" defaultValue={baby.birthDate ?? ""} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="text-sm" htmlFor={`edit-feed-${baby.id}`}>Feed warning (min)</label>
          <Input id={`edit-feed-${baby.id}`} name="feedingWarningMinutes" type="number" min="1" defaultValue={baby.feedingWarningMinutes ?? ""} />
        </div>
        <div>
          <label className="text-sm" htmlFor={`edit-diaper-${baby.id}`}>Diaper warning (min)</label>
          <Input id={`edit-diaper-${baby.id}`} name="diaperWarningMinutes" type="number" min="1" defaultValue={baby.diaperWarningMinutes ?? ""} />
        </div>
        <div>
          <label className="text-sm" htmlFor={`edit-timer-${baby.id}`}>Timer warning (min)</label>
          <Input id={`edit-timer-${baby.id}`} name="sleepWarningMinutes" type="number" min="1" defaultValue={baby.sleepWarningMinutes ?? ""} />
        </div>
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor={`edit-notes-${baby.id}`}>Notes</label>
        <Textarea id={`edit-notes-${baby.id}`} name="notes" defaultValue={baby.notes ?? ""} />
      </div>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {saved && !error ? <p className="text-sm text-muted-foreground" role="status">Saved.</p> : null}
      <Button disabled={saving}>{saving ? "Saving..." : "Save changes"}</Button>
    </form>
  );
}
