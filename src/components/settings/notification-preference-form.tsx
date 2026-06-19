"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function NotificationPreferenceForm({ babies }: { babies: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    const response = await fetch("/api/notifications/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        babyId: formData.get("babyId") || undefined,
        timerOverdue: formData.get("timerOverdue") === "on",
        activityCreated: formData.get("activityCreated") === "on",
        reminders: formData.get("reminders") === "on",
        quietHoursStart: formData.get("quietHoursStart") || undefined,
        quietHoursEnd: formData.get("quietHoursEnd") || undefined
      })
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-3">
      <select name="babyId" className="min-h-11 w-full rounded-lg border border-border bg-card px-3">
        <option value="">All babies</option>
        {babies.map((baby) => (
          <option key={baby.id} value={baby.id}>
            {baby.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input name="timerOverdue" type="checkbox" defaultChecked />
        Timer overdue
      </label>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input name="activityCreated" type="checkbox" />
        Activity created
      </label>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input name="reminders" type="checkbox" defaultChecked />
        Reminders
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="quietHoursStart" type="time" className="min-h-11 rounded-lg border border-border bg-card px-3" />
        <input name="quietHoursEnd" type="time" className="min-h-11 rounded-lg border border-border bg-card px-3" />
      </div>
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button>Save preference</Button>
    </form>
  );
}
