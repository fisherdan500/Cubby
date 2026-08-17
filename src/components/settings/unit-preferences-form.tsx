"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UnitPreferences } from "@/domain/unit-preferences";

type Props = { preferences: UnitPreferences; medicineNames: string[]; supplementNames: string[] };
const pendingKey = "cubby:unit-preferences-operation";

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

export function UnitPreferencesForm({ preferences, medicineNames, supplementNames }: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(formData: FormData) {
    setError(""); setSaved(false); setSubmitting(true);
    try {
      const retained = sessionStorage.getItem(pendingKey);
      if (retained) {
        const response = await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" });
        const result = await response.json() as { ok?: boolean; data?: { status?: string } };
        if (response.ok && result.data?.status === "completed") {
          sessionStorage.removeItem(pendingKey); setSaved(true); router.refresh();
        } else if (response.status === 202) {
          setError("Unit defaults outcome is still unknown. Retry reconciliation before changing it again.");
        } else { sessionStorage.removeItem(pendingKey); setError("This unit-default request is no longer available. Refresh and choose again."); }
        return;
      }
      const id = operationId();
      sessionStorage.setItem(pendingKey, id);
      const issue = await fetch("/api/settings/units/issue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: id }) });
      const issued = await issue.json() as { ok?: boolean; data?: { status?: string }; error?: { message?: string } };
      if (!issue.ok || issued.data?.status !== "open") {
        if (issued.data?.status !== "pending") sessionStorage.removeItem(pendingKey);
        setError(issued.error?.message ?? "Could not open a unit-default request."); return;
      }
      const response = await fetch("/api/settings/units", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: id, volume: formData.get("volume"), weight: formData.get("weight"), length: formData.get("length"), temperature: formData.get("temperature"), medicineUnits: itemUnits(formData, "medicine", medicineNames), supplementUnits: itemUnits(formData, "supplement", supplementNames) })
      });
      const result = await response.json() as { ok?: boolean; data?: { status?: string }; error?: { message?: string } };
      if (!response.ok || !result.ok) { setError(result.error?.message ?? "Could not save unit defaults."); return; }
      if (result.data?.status === "completed") { sessionStorage.removeItem(pendingKey); setSaved(true); router.refresh(); }
      else setError("Unit defaults outcome is still unknown. Retry reconciliation before changing it again.");
    } catch { setError("Could not reach Cubby. Check your connection and try again."); }
    finally { setSubmitting(false); }
  }

  return <form action={submit} className="mt-5 space-y-6">
    <section className="space-y-3"><h3 className="font-bold">Measurements</h3><div className="grid gap-3 sm:grid-cols-2">
      <UnitSelect name="volume" label="Volume" value={preferences.volume} options={[{ value: "oz", label: "Ounces (oz)" }, { value: "mL", label: "Milliliters (mL)" }]} />
      <UnitSelect name="weight" label="Weight" value={preferences.weight} options={[{ value: "lb", label: "Pounds (lb)" }, { value: "kg", label: "Kilograms (kg)" }]} />
      <UnitSelect name="length" label="Length and head circumference" value={preferences.length} options={[{ value: "in", label: "Inches (in)" }, { value: "cm", label: "Centimeters (cm)" }]} />
      <UnitSelect name="temperature" label="Temperature" value={preferences.temperature} options={[{ value: "F", label: "Fahrenheit (°F)" }, { value: "C", label: "Celsius (°C)" }]} />
    </div></section>
    <ItemUnits title="Medicine dose units" kind="medicine" names={medicineNames} units={preferences.medicineUnits} />
    <ItemUnits title="Supplement dose units" kind="supplement" names={supplementNames} units={preferences.supplementUnits} />
    {error ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
    {saved ? <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm font-semibold text-primary">Unit defaults saved.</p> : null}
    <Button type="submit" disabled={submitting}>{submitting ? "Saving..." : "Save unit defaults"}</Button>
  </form>;
}

function itemUnits(formData: FormData, kind: string, names: string[]) {
  return Object.fromEntries(names.flatMap((name, index) => { const unit = String(formData.get(`${kind}-${index}`) ?? "").trim(); return unit ? [[name, unit]] : []; }));
}
function UnitSelect({ name, label, value, options }: { name: string; label: string; value: string; options: Array<{ value: string; label: string }> }) {
  return <label className="block space-y-2 text-sm font-semibold">{label}<select name={name} defaultValue={value} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
function ItemUnits({ title, kind, names, units }: { title: string; kind: "medicine" | "supplement"; names: string[]; units: Record<string, string> }) {
  return <section className="space-y-3 border-t border-border pt-5"><div><h3 className="font-bold">{title}</h3><p className="text-sm text-muted-foreground">Names appear here after they are logged or restored from a backup.</p></div>{names.length ? <div className="grid gap-3 sm:grid-cols-2">{names.map((name, index) => <label key={name} className="block space-y-2 text-sm font-semibold">{name}<Input name={`${kind}-${index}`} defaultValue={units[name] ?? ""} maxLength={20} placeholder="e.g. mL, drops, tablet" /></label>)}</div> : <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No {kind} names have been logged yet.</p>}</section>;
}
