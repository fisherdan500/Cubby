"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

export function OnboardingForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    const body = Object.fromEntries(formData);
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
    router.push("/app");
    router.refresh();
  }

  return (
    <form action={submit} className="space-y-4">
      <label className="block space-y-2 text-sm font-semibold">
        Household name
        <Input name="householdName" placeholder="The Fisher Family" required />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Baby name
        <Input name="babyName" required />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Birth date
        <Input name="birthDate" type="date" />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Timezone
        <Input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required />
      </label>
      <Textarea className="hidden" aria-hidden />
      {error ? <p className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button className="w-full">Start tracking</Button>
    </form>
  );
}
