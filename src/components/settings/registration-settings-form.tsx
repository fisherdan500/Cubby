"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function RegistrationSettingsForm({
  allowPublicRegistration,
  allowNewHouseholdCreation
}: {
  allowPublicRegistration: boolean;
  allowNewHouseholdCreation: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setError("");
    const response = await fetch("/api/settings/registration", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        allowPublicRegistration: formData.get("allowPublicRegistration") === "on",
        allowNewHouseholdCreation: formData.get("allowNewHouseholdCreation") === "on"
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
    <form action={submit} className="space-y-4">
      <label className="flex items-start gap-3 rounded-md bg-muted p-3">
        <input name="allowPublicRegistration" type="checkbox" defaultChecked={allowPublicRegistration} className="mt-1" />
        <span>
          <span className="block font-bold">Public account creation</span>
          <span className="text-sm text-muted-foreground">Show and allow normal create-account signups after owner setup.</span>
        </span>
      </label>
      <label className="flex items-start gap-3 rounded-md bg-muted p-3">
        <input name="allowNewHouseholdCreation" type="checkbox" defaultChecked={allowNewHouseholdCreation} className="mt-1" />
        <span>
          <span className="block font-bold">New household creation</span>
          <span className="text-sm text-muted-foreground">Allow signed-in users without a household to create a separate household.</span>
        </span>
      </label>
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button>Save registration policy</Button>
    </form>
  );
}
