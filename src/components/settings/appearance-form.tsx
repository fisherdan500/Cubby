"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accentThemeDetails, accentThemes, type AccentTheme } from "@/domain/appearance";
import { cn } from "@/lib/utils";

export function AppearanceForm({ initialTheme }: { initialTheme: AccentTheme }) {
  const router = useRouter();
  const [selected, setSelected] = useState<AccentTheme>(initialTheme);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/settings/appearance", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accentTheme: selected })
    });
    const result = await response.json();
    setSaving(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setMessage("Appearance saved for the household.");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {accentThemes.map((theme) => {
          const details = accentThemeDetails[theme];
          const active = selected === theme;
          return (
            <button
              key={theme}
              type="button"
              onClick={() => setSelected(theme)}
              className={cn(
                "relative min-h-24 rounded-lg border bg-card p-3 text-left transition",
                active ? "border-primary ring-2 ring-primary/25" : "border-border hover:bg-muted"
              )}
              aria-pressed={active}
            >
              <span className="mb-3 block h-8 w-8 rounded-full border border-black/10" style={{ backgroundColor: details.swatch }} />
              <span className="block text-sm font-bold">{details.label}</span>
              <span className="block text-xs text-muted-foreground">{details.description}</span>
              {active ? (
                <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || selected === initialTheme}>
        {saving ? "Saving..." : "Save appearance"}
      </Button>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  );
}
