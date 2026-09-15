"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UnitPreferences } from "@/domain/unit-preferences";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type Props = { preferences: UnitPreferences; medicineNames: string[]; supplementNames: string[] };
type UnitOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };

function unitOperationStorageKey(partition: string) {
  return `cubby:unit-preferences-operation:${partition}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.version !== 1 || body.data.scope !== "household") {
    throw new Error(body?.error?.message ?? "Could not establish the current household operation scope.");
  }
  return body.data;
}

async function unitOperationResponse(response: Response) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: { status?: UnitOperationStatus; operationId?: string };
    error?: { message?: string };
  } | null;
  return { response, body, status: body?.ok ? body.data?.status : undefined };
}

export function UnitPreferencesForm({ preferences, medicineNames, supplementNames }: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function clearOperation(storageKey: string) {
    sessionStorage.removeItem(storageKey);
  }

  async function submitReservation(id: string, storageKey: string, formData: FormData) {
    const result = await unitOperationResponse(await fetch("/api/settings/units", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: id, volume: formData.get("volume"), weight: formData.get("weight"), length: formData.get("length"), temperature: formData.get("temperature"), medicineUnits: itemUnits(formData, "medicine", medicineNames), supplementUnits: itemUnits(formData, "supplement", supplementNames) })
    }));
    if (isAuthorizedBrowserOperation410(result.response.status, result.body, id)) {
      clearOperation(storageKey); setError("This unit-default request expired. Save again to open a new request.");
    } else if (result.status === "completed") {
      clearOperation(storageKey); setSaved(true); router.refresh();
    } else if (result.status === "pending") {
      setError("Unit defaults outcome is still unknown. Retry reconciliation before changing it again.");
    } else if (result.status === "stale" || result.status === "rejected") {
      setError("This unit-default request is no longer current. Refresh and choose again.");
    } else {
      setError(result.body?.error?.message ?? "Could not save unit defaults. Reconcile before retrying.");
    }
  }

  async function submit(formData: FormData) {
    setError(""); setSaved(false); setSubmitting(true);
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, unitOperationStorageKey(partition));
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const result = await unitOperationResponse(await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(result.response.status, result.body, retained)) {
          clearOperation(storageKey); setError("This unit-default request expired. Save again to open a new request.");
        } else if (result.status === "completed") {
          clearOperation(storageKey); setSaved(true); router.refresh();
        } else if (result.status === "prepared") {
          await submitReservation(retained, storageKey, formData);
        } else if (result.status === "pending") {
          setError("Unit defaults outcome is still unknown. Retry reconciliation before changing it again.");
        } else if (result.status === "stale" || result.status === "rejected") {
          setError("This unit-default request is no longer current. Refresh and choose again.");
        } else {
          setError("Could not reconcile this unit-default request. Try again before changing it.");
        }
        return;
      }
      const issued = await unitOperationResponse(await fetch("/api/settings/units/issue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
      }));
      const id = issued.body?.data?.operationId;
      if (!id) throw new Error(issued.body?.error?.message ?? "Could not open a unit-default request.");
      sessionStorage.setItem(storageKey, id);
      if (issued.status === "open" || issued.status === "prepared") {
        await submitReservation(id, storageKey, formData);
      } else if (issued.status === "pending") {
        setError("Unit defaults outcome is still unknown. Retry reconciliation before changing it again.");
      } else if (issued.status === "stale" || issued.status === "rejected" || issued.status === "expired") {
        setError("This unit-default request is no longer current. Refresh and choose again.");
      }
    } catch { setError("Could not reach Cubby. Check your connection and reconcile before retrying."); }
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
    {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
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
