"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import type { HouseholdRole } from "@prisma/client";

export type HouseholdSelectionOption = {
  memberId: string;
  householdId: string;
  householdName: string;
  role: HouseholdRole;
  accentTheme?: string;
};

export type HouseholdSelectionState = {
  status: "selected" | "missing" | "stale";
  selected: HouseholdSelectionOption | null;
  options: HouseholdSelectionOption[];
};

export function HouseholdSelectionControl({ state }: { state: HouseholdSelectionState }) {
  const [error, setError] = useState("");
  const message = state.status === "missing"
    ? "Select a household to continue."
    : state.status === "stale"
      ? "Your previous household selection is no longer available."
      : null;

  async function submit(formData: FormData) {
    setError("");
    const response = await fetch("/api/household-selection", {
      method: "POST",
      body: formData
    });
    if (response.redirected) {
      window.location.assign(response.url);
      return;
    }
    const result = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    setError(result?.error?.message ?? "Household selection could not be updated.");
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(new FormData(event.currentTarget));
  }

  return (
    <section
      className="border-b border-border bg-card px-3 py-2 text-card-foreground md:px-8"
      aria-label="Household selection"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {state.selected ? "Current household" : "Household selection required"}
          </p>
          <p className="truncate text-sm font-semibold">
            {state.selected?.householdName ?? message}
          </p>
        </div>
        {state.options.length ? (
          <form onSubmit={onSubmit} className="flex min-w-0 flex-1 basis-64 flex-wrap items-end gap-2">
            <input type="hidden" name="returnTo" value="/app" />
            <label className="min-w-0 flex-1 text-xs font-bold">
              Choose household
              <select
                name="memberId"
                defaultValue={state.selected?.memberId ?? ""}
                required
                className="mt-1 min-h-11 w-full rounded-md border border-control bg-background px-3 text-sm text-foreground"
              >
                {!state.selected ? <option value="" disabled>Select a household</option> : null}
                {state.options.map((option) => (
                  <option key={option.memberId} value={option.memberId}>{option.householdName}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
              {state.selected ? "Switch" : "Continue"}
            </button>
          </form>
        ) : (
          <Link href="/onboarding" className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Continue to household setup
          </Link>
        )}
      </div>
      {error ? <p className="mx-auto mt-2 max-w-7xl text-sm text-danger">{error}</p> : null}
    </section>
  );
}
