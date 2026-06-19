"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
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
        ? await authClient.signUp.email({ email, password, name, callbackURL: "/onboarding" })
        : await authClient.signIn.email({ email, password, rememberMe: true, callbackURL: "/app" });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? "Authentication failed.");
      return;
    }
    router.push(mode === "register" ? "/onboarding" : "/app");
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
      <p className="text-center text-sm text-muted-foreground">
        {mode === "register" ? "Already have an account?" : "Need an account?"}{" "}
        <Link className="font-semibold text-primary" href={mode === "register" ? "/login" : "/register"}>
          {mode === "register" ? "Sign in" : "Create one"}
        </Link>
      </p>
    </form>
  );
}
