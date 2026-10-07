"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

export function OnboardingForm({ canRestore = false }: { canRestore?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"create" | "restore">("create");
  const restoring = canRestore && mode === "restore";

  async function submit(formData: FormData) {
    setError("");
    formData.delete("onboardingPath");
    const body = Object.fromEntries(formData);
    if (restoring) body.mode = "restore";
    const response = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.push(restoring ? "/app/settings/backups" : "/app");
    router.refresh();
  }

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void submit(new FormData(event.currentTarget));
    }} className="space-y-4">
      {canRestore ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-bold">How would you like to start?</legend>
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-border p-3 text-sm font-semibold">
            <input type="radio" name="onboardingPath" value="create" checked={!restoring} onChange={() => { setMode("create"); setError(""); }} />
            Create a new household and first baby
          </label>
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-border p-3 text-sm font-semibold">
            <input type="radio" name="onboardingPath" value="restore" checked={restoring} onChange={() => { setMode("restore"); setError(""); }} />
            Restore household backup
          </label>
        </fieldset>
      ) : null}
      {restoring ? <p className="text-sm text-muted-foreground">
        Create an empty household first, then choose your backup in Settings. Current v2 restores adopt the archived household name;
        legacy v1 keeps the name you enter here. A failed or cancelled restore leaves this empty household in your ownership.
      </p> : null}
      <label className="block space-y-2 text-sm font-semibold">
        {restoring ? "Recovery-target household name" : "Household name"}
        <Input name="householdName" placeholder="The Fisher Family" maxLength={80} required />
      </label>
      {!restoring ? (
        <>
          <label className="block space-y-2 text-sm font-semibold">
            Baby name
            <Input name="babyName" required />
          </label>
          <label className="block space-y-2 text-sm font-semibold">
            Birth date
            <Input name="birthDate" type="date" />
          </label>
        </>
      ) : null}
      <Textarea className="hidden" aria-hidden />
      {error ? <p className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button className="w-full">{restoring ? "Create empty household and continue" : "Start tracking"}</Button>
    </form>
  );
}
