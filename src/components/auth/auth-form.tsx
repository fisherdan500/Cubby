"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email"));
    const password = String(formData.get("password"));
    try {
      const result = await authClient.signIn.email({ email, password, rememberMe: true, callbackURL: next });
      if (result.error) {
        setError(authFailureMessage("login", result.error));
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Unable to sign in right now. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form aria-label="Sign in" onSubmit={onSubmit} className="space-y-4">

      <label className="block space-y-2 text-sm font-semibold">
        Email
        <Input name="email" type="email" autoComplete="username" autoFocus required aria-invalid={error ? true : undefined} aria-describedby={error ? "sign-in-error" : undefined} />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Password
        <Input name="password" type="password" autoComplete="current-password" required minLength={8} aria-invalid={error ? true : undefined} aria-describedby={error ? "sign-in-error" : undefined} />
      </label>
      {error ? <p ref={errorRef} id="sign-in-error" role="alert" aria-live="assertive" aria-atomic="true" tabIndex={-1} className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Working..." : "Sign in"}
      </Button>
    </form>
  );
}
