"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accentThemeDetails, accentThemes, type AccentTheme } from "@/domain/appearance";
import { cn } from "@/lib/utils";

const pendingKey = "cubby:household-accent-operation";

type OperationResult = { status: "open" | "pending" | "completed" | "rejected" | "stale" | "expired"; operationId: string; code?: string };

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

async function parseResult(response: Response): Promise<OperationResult> {
  const body = await response.json() as { ok: boolean; data?: OperationResult; error?: { message?: string } };
  if (!body.ok || !body.data) throw new Error(body.error?.message ?? "Could not save the Family accent.");
  return body.data;
}

export function AppearanceForm({ initialTheme }: { initialTheme: AccentTheme }) {
  const router = useRouter();
  const [selected, setSelected] = useState<AccentTheme>(initialTheme);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function reconcile(id: string) {
    const response = await fetch(`/api/browser-operations/${id}`, { cache: "no-store" });
    return parseResult(response);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    const retained = sessionStorage.getItem(pendingKey);
    const id = retained ?? operationId();
    try {
      if (retained) {
        const outcome = await reconcile(id);
        if (outcome.status === "completed") {
          sessionStorage.removeItem(pendingKey);
          setMessage("Family accent saved.");
          router.refresh();
        } else if (outcome.status === "pending") {
          setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
        } else {
          sessionStorage.removeItem(pendingKey);
          setMessage("This Family accent request is no longer available. Refresh and choose again.");
        }
        return;
      }
      sessionStorage.setItem(pendingKey, id);
      const issued = await parseResult(await fetch("/api/settings/appearance/issue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: id })
      }));
      if (issued.status === "pending") {
        setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
        return;
      }
      if (issued.status !== "open") {
        sessionStorage.removeItem(pendingKey);
        setMessage("This Family accent request is no longer available. Refresh and choose again.");
        return;
      }
      const submitted = await parseResult(await fetch("/api/settings/appearance", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: id, accentTheme: selected })
      }));
      if (submitted.status === "completed") {
        sessionStorage.removeItem(pendingKey);
        setMessage("Family accent saved.");
        router.refresh();
      } else if (submitted.status === "pending") {
        setMessage("Family accent outcome is still unknown. Retry reconciliation before changing it again.");
      } else {
        sessionStorage.removeItem(pendingKey);
        setMessage("This Family accent request is no longer available. Refresh and choose again.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Family accent outcome is unknown. Reconcile it before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Family accent">
        {accentThemes.map((theme) => {
          const details = accentThemeDetails[theme];
          const active = selected === theme;
          return <button key={theme} type="button" role="radio" aria-checked={active} onClick={() => setSelected(theme)} className={cn("relative min-h-24 rounded-lg border bg-card p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary ring-2 ring-primary/25" : "border-border hover:bg-muted")}>
            <span className="mb-3 block h-8 w-8 rounded-full border border-black/10" style={{ backgroundColor: details.swatch }} />
            <span className="block text-sm font-bold">{details.label}</span><span className="block text-xs text-muted-foreground">{details.description}</span>
            {active ? <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3.5 w-3.5" /></span> : null}
          </button>;
        })}
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || selected === initialTheme}>{saving ? "Saving..." : "Save Family accent"}</Button>
      {message ? <p className="text-sm text-muted-foreground" role="status">{message}</p> : null}
    </div>
  );
}
