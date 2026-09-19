"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PlatformSetupClaimForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(formData: FormData) {
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/platform/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: String(formData.get("code") ?? "") })
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.ok) {
        setError(body && !body.ok && body.error?.message ? body.error.message : "Could not complete setup. Try again.");
        return;
      }
      // The claim is one database transaction, so there is nothing to reconcile: it either made this
      // account the owner or changed nothing. Platform settings is where household creation opens.
      router.replace("/platform/settings");
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={submit} className="space-y-3">
      <label htmlFor="platform-setup-code" className="block text-sm font-semibold">
        Setup code
      </label>
      <Input
        id="platform-setup-code"
        name="code"
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        className="font-mono tracking-wider"
      />
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Checking..." : "Become platform owner"}
      </Button>
    </form>
  );
}
