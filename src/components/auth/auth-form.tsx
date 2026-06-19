"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

export function AuthForm({
  mode,
  next = mode === "register" ? "/onboarding" : "/app",
  allowRegisterLink = true,
  inviteToken
}: {
  mode: "login" | "register";
  next?: string;
  allowRegisterLink?: boolean;
  inviteToken?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    const email = String(formData.get("email"));
    const password = String(formData.get("password"));
    const name = String(formData.get("name") || email.split("@")[0]);
    const result =
      mode === "register"
        ? await authClient.signUp.email({ email, password, name, callbackURL: next })
        : await authClient.signIn.email({ email, password, rememberMe: true, callbackURL: next });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? "Authentication failed.");
      return;
    }
    if (mode === "register" && inviteToken) {
      const accept = await fetch(`/api/invites/${inviteToken}/accept`, { method: "POST" });
      if (!accept.ok) {
        setError("Account created, but the invite could not be accepted. Sign in and open the invite link again.");
        return;
      }
      router.push("/app");
      router.refresh();
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {mode === "register" ? (
        <label className="block space-y-2 text-sm font-semibold">
          Name
          <Input name="name" autoComplete="name" required />
        </label>
      ) : null}
      <label className="block space-y-2 text-sm font-semibold">
        Email
        <Input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        Password
        <Input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} />
      </label>
      {error ? <p className="rounded-lg bg-red-500/10 p-3 text-sm text-danger">{error}</p> : null}
      <Button className="w-full" disabled={loading}>
        {loading ? "Working..." : mode === "register" ? "Create account" : "Sign in"}
      </Button>
      {mode === "register" ? (
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link className="font-semibold text-primary" href={`/login?next=${encodeURIComponent(next)}`}>
            Sign in
          </Link>
        </p>
      ) : allowRegisterLink ? (
        <p className="text-center text-sm text-muted-foreground">
          Need an account?{" "}
          <Link className="font-semibold text-primary" href={`/register?next=${encodeURIComponent(next)}`}>
            Create one
          </Link>
        </p>
      ) : null}
    </form>
  );
}
