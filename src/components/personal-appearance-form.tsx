"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import type { AppearanceMode } from "@/domain/appearance";

const pendingKey = "cubby:account-appearance-operation";
const modes = [
  { value: "system" as const, label: "System", description: "Follow this device's light or dark setting." },
  { value: "light" as const, label: "Light", description: "Use light appearance on your signed-in devices." },
  { value: "dark" as const, label: "Dark", description: "Use dark appearance on your signed-in devices." }
];

type OperationResult = {
  status: "open" | "pending" | "completed" | "rejected" | "stale" | "expired";
  operationId: string;
  outcome?: { appearanceMode?: AppearanceMode; appearanceRevision?: number };
  code?: string;
};

function newOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

async function responseResult(response: Response): Promise<OperationResult> {
  const body = await response.json() as { ok: boolean; data?: OperationResult; error?: { message?: string } };
  if (!body.ok || !body.data) throw new Error(body.error?.message ?? "Appearance could not be updated.");
  return body.data;
}

export function PersonalAppearanceForm({
  initialMode,
  initialRevision
}: {
  initialMode: AppearanceMode;
  initialRevision: number;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [selected, setSelected] = useState<AppearanceMode>(initialMode);
  const [revision, setRevision] = useState(initialRevision);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function apply(result: OperationResult) {
    if (result.status === "completed" && result.outcome?.appearanceMode) {
      setSelected(result.outcome.appearanceMode);
      setRevision((current) => result.outcome?.appearanceRevision ?? current);
      setTheme(result.outcome.appearanceMode);
      sessionStorage.removeItem(pendingKey);
      setMessage("Personal appearance saved.");
      router.refresh();
      return true;
    }
    if (result.status === "rejected" || result.status === "stale" || result.status === "expired") {
      sessionStorage.removeItem(pendingKey);
      setMessage(result.code === "stale_revision" ? "Appearance changed in another tab. Refresh and choose again." : "This appearance request is no longer available.");
    }
    return false;
  }

  async function reconcile(operationId: string) {
    const response = await fetch(`/api/account/browser-operations/${operationId}`, { cache: "no-store" });
    const result = await responseResult(response);
    apply(result);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    const retained = sessionStorage.getItem(pendingKey);
    if (retained) {
      try {
        await reconcile(retained);
      } catch {
        setMessage("Appearance outcome is still unknown. Retry reconciliation before starting another change.");
      } finally {
        setSaving(false);
      }
      return;
    }
    const operationId = newOperationId();
    sessionStorage.setItem(pendingKey, operationId);
    try {
      const issued = await responseResult(await fetch("/api/account/appearance/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId })
      }));
      if (apply(issued)) return;
      if (issued.status === "pending") {
        await reconcile(operationId);
        return;
      }
      if (issued.status !== "open") return;
      const submitted = await responseResult(await fetch("/api/account/appearance", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, appearanceMode: selected })
      }));
      if (!apply(submitted) && submitted.status === "pending") await reconcile(operationId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Appearance outcome is unknown. Reconcile this request before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-appearance-revision={revision}>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Personal appearance mode">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={selected === mode.value}
            onClick={() => setSelected(mode.value)}
            className="min-h-24 rounded-lg border border-border bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block text-sm font-bold">{mode.label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{mode.description}</span>
          </button>
        ))}
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || selected === initialMode}>
        {saving ? "Saving…" : "Save personal appearance"}
      </Button>
      {message ? <p className="text-sm text-muted-foreground" role="status">{message}</p> : null}
    </div>
  );
}
