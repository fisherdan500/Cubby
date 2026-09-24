"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PlatformFirstAccountForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(formData: FormData) {
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/platform/setup/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          email: String(formData.get("email") ?? ""),
          password: String(formData.get("password") ?? "")
        })
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.ok) {
        setError(body && !body.ok && body.error?.message ? body.error.message : "Could not create the account. Try again.");
        return;
      }
      // One database transaction made the account and the owner or changed nothing, so the next step is
      // simply the ordinary sign-in, with the password just chosen.
      router.replace("/login");
    } catch {
      setError("Could not reach Cubby. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={submit} className="space-y-3">
      <label htmlFor="first-account-code" className="block text-sm font-semibold">
        Setup code
      </label>
      <Input
        id="first-account-code"
        name="code"
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        className="font-mono tracking-wider"
      />
      <label htmlFor="first-account-name" className="block text-sm font-semibold">
        Your name
      </label>
      <Input id="first-account-name" name="name" required maxLength={120} autoComplete="name" />
      <label htmlFor="first-account-email" className="block text-sm font-semibold">
        Email
      </label>
      <Input id="first-account-email" name="email" type="email" required maxLength={254} autoComplete="email" />
      <label htmlFor="first-account-password" className="block text-sm font-semibold">
        Password
      </label>
      <Input
        id="first-account-password"
        name="password"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
      />
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Creating..." : "Create account and become owner"}
      </Button>
    </form>
  );
}
