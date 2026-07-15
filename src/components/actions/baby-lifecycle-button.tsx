"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BabyLifecycleButton({
  babyId,
  babyName,
  inactive,
  className
}: {
  babyId: string;
  babyName: string;
  inactive: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!inactive && !window.confirm(`Deactivate ${babyName}? Existing history will remain available.`)) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/babies/${babyId}/${inactive ? "reactivate" : "deactivate"}`, {
        method: "POST"
      });
      const result = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!response.ok || !result?.ok) {
        setError(result && !result.ok ? result.error?.message ?? "Could not update this baby." : "Could not update this baby.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach Cubby. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant={inactive ? "secondary" : "primary"}
        className="min-h-11"
        disabled={submitting}
        onClick={submit}
      >
        {submitting ? "Saving..." : inactive ? "Reactivate" : "Deactivate"}
      </Button>
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
