"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

type PreferenceState = "unsaved_off" | "active" | "needs_review";
type PreferenceOperationStatus = "open" | "prepared" | "pending" | "completed" | "rejected" | "stale" | "expired";
type Partition = { version: 1; scope: "household"; partition: string };

function notificationOperationStorageKey(partition: string) {
  return `cubby:notification-preference-operation:${partition}`;
}

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.version !== 1 || body.data.scope !== "household") {
    throw new Error(body?.error?.message ?? "Could not establish the current household operation scope.");
  }
  return body.data;
}

async function preferenceResponse(response: Response) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: { status?: PreferenceOperationStatus; operationId?: string };
    error?: { message?: string };
  } | null;
  return { response, body, status: body?.ok ? body.data?.status : undefined };
}

export function NotificationPreferenceForm({ babies, state = "unsaved_off" }: { babies: Array<{ id: string; name: string }>; state?: PreferenceState }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function clearOperation(storageKey: string) {
    sessionStorage.removeItem(storageKey);
  }

  async function submitReservation(id: string, storageKey: string, formData: FormData) {
    const babyIds = formData.getAll("babyIds").map(String);
    const result = await preferenceResponse(await fetch("/api/notifications/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: id,
        externalDeliveryEnabled: formData.get("externalDeliveryEnabled") === "on",
        babyScope: formData.get("babyScope") === "selected" ? { mode: "selected", babyIds } : { mode: "all" },
        categories: ["timer_overdue", "activity_created", "reminder_due"].filter((value) => formData.get(value) === "on"),
        channels: formData.get("browser_push") === "on" ? ["browser_push"] : [],
        quietHoursStart: formData.get("quietHoursStart") || undefined,
        quietHoursEnd: formData.get("quietHoursEnd") || undefined,
        interruptionLevel: formData.get("interruptionLevel")
      })
    }));
    if (isAuthorizedBrowserOperation410(result.response.status, result.body, id)) {
      clearOperation(storageKey); setMessage("This notification preference request expired. Save again to open a new request.");
    } else if (result.status === "completed") {
      clearOperation(storageKey); setMessage("Notification preferences saved."); router.refresh();
    } else if (result.status === "pending") {
      setMessage("Notification preference outcome is still unknown. Reconcile it before changing it again.");
    } else if (result.status === "stale" || result.status === "rejected") {
      setMessage("This notification preference request is no longer current. Refresh and review it again.");
    } else {
      setMessage(result.body?.error?.message ?? "Could not save notification preferences. Reconcile before retrying.");
    }
  }

  async function submit(formData: FormData) {
    setMessage(""); setSaving(true);
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, notificationOperationStorageKey(partition));
      const retained = sessionStorage.getItem(storageKey);
      if (retained) {
        const result = await preferenceResponse(await fetch(`/api/browser-operations/${retained}`, { cache: "no-store" }));
        if (isAuthorizedBrowserOperation410(result.response.status, result.body, retained)) {
          clearOperation(storageKey); setMessage("This notification preference request expired. Save again to open a new request.");
        } else if (result.status === "completed") {
          clearOperation(storageKey); setMessage("Notification preferences saved."); router.refresh();
        } else if (result.status === "prepared") {
          await submitReservation(retained, storageKey, formData);
        } else if (result.status === "pending") {
          setMessage("Notification preference outcome is still unknown. Reconcile it before changing it again.");
        } else if (result.status === "stale" || result.status === "rejected") {
          setMessage("This notification preference request is no longer current. Refresh and review it again.");
        } else {
          setMessage("Could not reconcile this notification preference request. Try again before changing it.");
        }
        return;
      }
      const issued = await preferenceResponse(await fetch("/api/notifications/preferences/issue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
      }));
      const id = issued.body?.data?.operationId;
      if (!id) throw new Error(issued.body?.error?.message ?? "Could not open notification preferences.");
      sessionStorage.setItem(storageKey, id);
      if (issued.status === "open" || issued.status === "prepared") {
        await submitReservation(id, storageKey, formData);
      } else if (issued.status === "pending") {
        setMessage("Notification preference outcome is still unknown. Reconcile it before changing it again.");
      } else if (issued.status === "stale" || issued.status === "rejected" || issued.status === "expired") {
        setMessage("This notification preference request is no longer current. Refresh and review it again.");
      }
    } catch { setMessage("Could not reach Cubby. Check your connection and reconcile before retrying."); }
    finally { setSaving(false); }
  }

  return <form action={submit} className="space-y-4">
    <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground" role="status">{state === "needs_review" ? "Your previous notification preferences need review. External delivery remains off until you save this complete replacement." : state === "unsaved_off" ? "External delivery is off until you deliberately save preferences." : "These preferences apply only to your current household membership."}</p>
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input name="externalDeliveryEnabled" type="checkbox" /> Enable external delivery</label>
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Baby scope</legend><label className="mr-4 inline-flex min-h-11 items-center gap-2"><input name="babyScope" type="radio" value="all" defaultChecked /> All active babies</label><label className="inline-flex min-h-11 items-center gap-2"><input name="babyScope" type="radio" value="selected" /> Selected babies</label><select name="babyIds" multiple className="min-h-24 w-full rounded-lg border border-border bg-card px-3 py-2" aria-label="Selected babies">{babies.map((baby) => <option key={baby.id} value={baby.id}>{baby.name}</option>)}</select></fieldset>
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Categories</legend>{[["timer_overdue", "Timer overdue"], ["activity_created", "Activity created"], ["reminder_due", "Reminders"]].map(([value, label]) => <label key={value} className="mr-4 inline-flex min-h-11 items-center gap-2 text-sm"><input name={value} type="checkbox" />{label}</label>)}</fieldset>
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input name="browser_push" type="checkbox" /> Browser push channel</label>
    <div className="grid gap-3 sm:grid-cols-2"><Input name="quietHoursStart" type="time" aria-label="Quiet hours start" /><Input name="quietHoursEnd" type="time" aria-label="Quiet hours end" /></div>
    <label className="block text-sm font-semibold">Interruption level<select name="interruptionLevel" defaultValue="normal" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-card px-3"><option value="passive">Passive</option><option value="normal">Normal</option><option value="time_sensitive">Time sensitive</option></select></label>
    {message ? <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm text-primary">{message}</p> : null}
    <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save notification preferences"}</Button>
  </form>;
}
