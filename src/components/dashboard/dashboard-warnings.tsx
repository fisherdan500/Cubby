"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import type { DashboardWarningItem } from "@/server/services/dashboard";

export function DashboardWarnings({ warnings }: { warnings: DashboardWarningItem[] }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(() => new Set<string>());
  const visible = warnings.filter((warning) => !hidden.has(warning.fingerprint));
  if (!visible.length) return null;

  async function dismiss(warning: DashboardWarningItem) {
    setHidden((current) => new Set(current).add(warning.fingerprint));
    const response = await fetch("/api/dashboard/warnings/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        babyId: warning.babyId,
        type: warning.type,
        fingerprint: warning.fingerprint
      })
    });
    if (!response.ok) {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(warning.fingerprint);
        return next;
      });
      return;
    }
    router.refresh();
  }

  return (
    <Card className="border-accent bg-accent/10">
      <div className="flex gap-3">
        <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">Needs a glance</h2>
          <p className="text-sm text-muted-foreground">{visible.map((warning) => warning.message).join(" - ")}</p>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Dismiss warning"
          onClick={() => void Promise.all(visible.map(dismiss))}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </Card>
  );
}
