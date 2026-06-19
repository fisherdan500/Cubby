"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

export function BabyForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    const response = await fetch("/api/babies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
    (document.getElementById("baby-form") as HTMLFormElement | null)?.reset();
  }

  return (
    <form id="baby-form" action={submit} className="space-y-3">
      <Input name="name" placeholder="Baby name" required />
      <Input name="birthDate" type="date" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Input name="feedingWarningMinutes" type="number" min="1" placeholder="Feed warning minutes" defaultValue="240" />
        <Input name="diaperWarningMinutes" type="number" min="1" placeholder="Diaper warning minutes" defaultValue="240" />
        <Input name="sleepWarningMinutes" type="number" min="1" placeholder="Timer warning minutes" defaultValue="360" />
      </div>
      <Textarea name="notes" placeholder="Notes" />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button>Add baby</Button>
    </form>
  );
}
