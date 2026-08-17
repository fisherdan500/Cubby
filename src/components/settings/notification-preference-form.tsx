"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PreferenceState = "unsaved_off" | "active" | "needs_review";
const pendingKey = "cubby:notification-preference-operation";

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

export function NotificationPreferenceForm({ babies, state = "unsaved_off" }: { babies: Array<{ id: string; name: string }>; state?: PreferenceState }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(formData: FormData) {
    setMessage(""); setSaving(true);
    const retained = sessionStorage.getItem(pendingKey);
    const id = retained ?? operationId();
    try {
      if (retained) {
        const response = await fetch(`/api/browser-operations/${id}`, { cache: "no-store" });
        const result = await response.json() as { ok?: boolean; data?: { status?: string } };
        if (response.ok && result.data?.status === "completed") { sessionStorage.removeItem(pendingKey); setMessage("Notification preferences saved."); router.refresh(); }
        else if (response.status === 202) setMessage("Notification preference outcome is still unknown. Reconcile it before changing it again.");
        else { sessionStorage.removeItem(pendingKey); setMessage("This notification preference request is no longer available. Refresh and try again."); }
        return;
      }
      sessionStorage.setItem(pendingKey, id);
      const issued = await fetch("/api/notifications/preferences/issue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: id }) });
      const issuedBody = await issued.json() as { ok?: boolean; data?: { status?: string }; error?: { message?: string } };
      if (!issued.ok || issuedBody.data?.status !== "open") {
        if (issuedBody.data?.status !== "pending") sessionStorage.removeItem(pendingKey);
        setMessage(issuedBody.error?.message ?? "Could not open notification preferences."); return;
      }
      const babyIds = formData.getAll("babyIds").map(String);
      const response = await fetch("/api/notifications/preferences", {
        method: "POST", headers: { "content-type": "application/json" },
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
      });
      const result = await response.json() as { ok?: boolean; data?: { status?: string }; error?: { message?: string } };
      if (!response.ok || !result.ok) { setMessage(result.error?.message ?? "Could not save notification preferences."); return; }
      if (result.data?.status === "completed") { sessionStorage.removeItem(pendingKey); setMessage("Notification preferences saved."); router.refresh(); }
      else setMessage("Notification preference outcome is still unknown. Reconcile it before changing it again.");
    } catch { setMessage("Could not reach Cubby. Check your connection and reconcile before retrying."); }
    finally { setSaving(false); }
  }

  return <form action={submit} className="space-y-4">
    <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground" role="status">{state === "needs_review" ? "Your previous notification preferences need review. External delivery remains off until you save this complete replacement." : state === "unsaved_off" ? "External delivery is off until you deliberately save preferences." : "These preferences apply only to your current household membership."}</p>
    <label className="flex items-center gap-2 text-sm font-semibold"><input name="externalDeliveryEnabled" type="checkbox" /> Enable external delivery</label>
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Baby scope</legend><label className="mr-4 inline-flex items-center gap-2"><input name="babyScope" type="radio" value="all" defaultChecked /> All active babies</label><label className="inline-flex items-center gap-2"><input name="babyScope" type="radio" value="selected" /> Selected babies</label><select name="babyIds" multiple className="min-h-24 w-full rounded-lg border border-border bg-card px-3 py-2" aria-label="Selected babies">{babies.map((baby) => <option key={baby.id} value={baby.id}>{baby.name}</option>)}</select></fieldset>
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Categories</legend>{[["timer_overdue", "Timer overdue"], ["activity_created", "Activity created"], ["reminder_due", "Reminders"]].map(([value, label]) => <label key={value} className="mr-4 inline-flex items-center gap-2 text-sm"><input name={value} type="checkbox" />{label}</label>)}</fieldset>
    <label className="flex items-center gap-2 text-sm font-semibold"><input name="browser_push" type="checkbox" /> Browser push channel</label>
    <div className="grid gap-3 sm:grid-cols-2"><Input name="quietHoursStart" type="time" aria-label="Quiet hours start" /><Input name="quietHoursEnd" type="time" aria-label="Quiet hours end" /></div>
    <label className="block text-sm font-semibold">Interruption level<select name="interruptionLevel" defaultValue="normal" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-card px-3"><option value="passive">Passive</option><option value="normal">Normal</option><option value="time_sensitive">Time sensitive</option></select></label>
    {message ? <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm text-primary">{message}</p> : null}
    <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save notification preferences"}</Button>
  </form>;
}
