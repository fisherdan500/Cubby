"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function RegistrationSettingsForm({
  householdCreationMode,
  allowPublicRegistration,
}: {
  householdCreationMode: "closed" | "invitation_only" | "open";
  allowPublicRegistration: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(formData: FormData) {
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/platform/registration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdCreationMode: formData.get("householdCreationMode"),
          allowPublicRegistration: formData.get("allowPublicRegistration") === "on"
        })
      });
      const result = await response.json();
      if (!result.ok) {
        setError(
          typeof result.error?.message === "string" ? result.error.message : "Unable to save policy."
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Unable to save policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form action={submit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-bold">Household creation</legend>
        <p className="text-sm text-muted-foreground">
          This policy applies to verified accounts without a household. Existing household invitations remain separate.
        </p>
        {[
          ["closed", "Closed", "No direct household creation."],
          [
            "invitation_only",
            "Invitation only",
            "Direct creation stays blocked. Creation-invitation issuance is delivered in a later slice."
          ],
          ["open", "Open", "Verified accounts without a household may create one."]
        ].map(([value, label, description]) => (
          <label key={value} className="flex items-start gap-3 rounded-md bg-muted p-3">
            <input
              name="householdCreationMode"
              type="radio"
              value={value}
              defaultChecked={householdCreationMode === value}
              className="mt-1"
            />
            <span>
              <span className="block font-bold">{label}</span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-3 rounded-md bg-muted p-3">
        <input name="allowPublicRegistration" type="checkbox" defaultChecked={allowPublicRegistration} className="mt-1" />
        <span>
          <span className="block font-bold">Public account creation</span>
          <span className="text-sm text-muted-foreground">
            Allow normal create-account signups. This does not grant household creation.
          </span>
        </span>
      </label>
      {error ? <p className="rounded-md bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button disabled={saving}>{saving ? "Saving…" : "Save registration policy"}</Button>
    </form>
  );
}
