"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { authFailureMessage } from "@/lib/auth/client-errors";

export function AuthForm({
  next = "/app"
}: {
  next?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    const email = String(formData.get("email"));
    const password = String(formData.get("password"));
    const result = await authClient.signIn.email({ email, password, rememberMe: true, callbackURL: next });
    setLoading(false);
    if (result.error) {
      setError(authFailureMessage("login", result.error));
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form action={onSubmit} className="space-y-4">

      <label className="block space-y-2 text-sm font-semibold">
        Email
        <Input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Password
        <Input name="password" type="password" autoComplete="current-password" required minLength={8} />
      </label>
      {error ? <p className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button className="w-full" disabled={loading}>
        {loading ? "Working..." : "Sign in"}
      </Button>
    </form>
  );
}
