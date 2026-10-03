"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Result = { ok: true; name: string } | { ok: false; message: string };

/**
 * Save a new name for the signed-in person.
 *
 * Exported apart from the control so the request can be tested without a DOM, the way the picture
 * control's upload sequence is.
 */
export async function saveOwnName(name: string): Promise<Result> {
  try {
    const response = await fetch("/api/members/me/name", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; data?: { name?: string }; error?: { message?: string } }
      | null;
    if (!response.ok || !body?.ok || typeof body.data?.name !== "string") {
      return { ok: false, message: body?.error?.message ?? "That name could not be saved. Try again." };
    }
    return { ok: true, name: body.data.name };
  } catch {
    return { ok: false, message: "Could not reach Cubby. Check your connection and try again." };
  }
}

/** Your own name, with the one control that changes it. */
export function ProfileNameControl({ name }: { name: string }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = value.trim();
  const unchanged = trimmed === name;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || unchanged) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await saveOwnName(trimmed);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setValue(result.name);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="own-name" className="block text-sm font-semibold">Your name</label>
      <input
        id="own-name"
        name="name"
        value={value}
        maxLength={80}
        required
        autoComplete="name"
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
        }}
        className="min-h-11 w-full rounded-lg border border-control bg-card px-3 text-base"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !trimmed || unchanged}
          className="inline-flex min-h-11 items-center rounded-lg border border-control bg-card px-3 text-sm font-semibold hover:bg-muted disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save your name"}
        </button>
        {saved ? <p className="text-xs font-semibold text-muted-foreground">Saved.</p> : null}
      </div>
      {error ? <p role="alert" className="text-xs font-semibold text-destructive">{error}</p> : null}
    </form>
  );
}
