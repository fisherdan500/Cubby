"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { ActivityArtwork } from "@/components/activity-artwork";
import {
  SELECTED_BABY_COOKIE,
  SELECTED_BABY_STORAGE_KEY,
  babySelectionHref,
  type HeaderBabySelectorData
} from "@/lib/baby-selector";

/**
 * "chip" is the desktop header control. "line" is the phone's replacement for the header: one line at
 * the top of the page - name and age at a glance - that scrolls away with the content instead of
 * holding a strip of the screen. Both can be mounted at once (the header is only hidden by CSS on a
 * phone), so only the chip reconciles the URL with the remembered selection; the line just reads and
 * changes it.
 */
export function HeaderBabySelector({ data, variant = "chip" }: { data: HeaderBabySelectorData; variant?: "chip" | "line" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState(data.selectedBabyId);
  const babyIds = useMemo(() => new Set(data.babies.map((baby) => baby.id)), [data.babies]);
  const selectedBaby = data.babies.find((baby) => baby.id === selectedId) ?? data.babies[0];
  const activeTimerType = selectedId === data.selectedBabyId ? data.activeTimerType : undefined;

  const replaceBabyId = useCallback(
    (nextBabyId: string) => {
      router.replace(babySelectionHref(pathname, searchParams.toString(), nextBabyId));
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    setSelectedId(data.selectedBabyId);
  }, [data.selectedBabyId]);

  useEffect(() => {
    if (variant !== "chip") return;
    const urlBabyId = searchParams.get("babyId");
    if (urlBabyId && babyIds.has(urlBabyId)) {
      persistSelection(urlBabyId);
      setSelectedId(urlBabyId);
      return;
    }

    const cachedBabyId = localStorage.getItem(SELECTED_BABY_STORAGE_KEY) ?? readCookie(SELECTED_BABY_COOKIE);
    if (cachedBabyId && babyIds.has(cachedBabyId) && cachedBabyId !== data.selectedBabyId) {
      setSelectedId(cachedBabyId);
      persistSelection(cachedBabyId);
      replaceBabyId(cachedBabyId);
      return;
    }

    persistSelection(data.selectedBabyId);
  }, [babyIds, data.selectedBabyId, replaceBabyId, searchParams, variant]);

  function choose(nextBabyId: string) {
    setSelectedId(nextBabyId);
    persistSelection(nextBabyId);
    router.push(babySelectionHref(pathname, searchParams.toString(), nextBabyId));
  }

  if (!selectedBaby) return null;

  const options = data.babies.map((baby) => (
    <option key={baby.id} value={baby.id}>
      {baby.name}{baby.inactive ? " (Inactive)" : ""} - {baby.ageLabel}
    </option>
  ));

  if (variant === "line") {
    // With one baby there is nothing to switch to, so the line is plain text with no chevron.
    const canSwitch = data.babies.length > 1;
    return (
      <div className="relative -mx-1 mb-2 flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1 focus-within:ring-2 focus-within:ring-ring">
        {activeTimerType ? <ActivityArtwork type={activeTimerType} size="xs" /> : null}
        <p className="min-w-0 truncate text-sm">
          <span className="font-semibold text-foreground">{selectedBaby.name}</span>
          {selectedBaby.inactive ? <span className="font-semibold text-muted-foreground"> · Inactive</span> : null}
          <span className="font-semibold text-muted-foreground"> · {selectedBaby.ageLabel}</span>
        </p>
        {canSwitch ? (
          <>
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <select
              aria-label="Select baby"
              value={selectedId}
              onChange={(event) => choose(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {options}
            </select>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative min-w-0 flex-1 rounded-full focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-primary sm:flex-none">
      <div className="flex min-h-12 items-center gap-2 rounded-full border border-primary-foreground/25 bg-card px-3 py-1.5 text-left font-bold text-card-foreground shadow-soft">
        {activeTimerType ? <ActivityArtwork type={activeTimerType} size="xs" /> : null}
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <span className="max-w-32 truncate text-sm sm:max-w-40 sm:text-base">{selectedBaby.name}</span>
            {selectedBaby.inactive ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">Inactive</span> : null}
          </div>
          <p className="text-xs font-semibold text-muted-foreground sm:text-sm">{selectedBaby.ageLabel}</p>
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          <ChevronDown className="h-4 w-4" />
        </span>
      </div>
      <select
        aria-label="Select baby"
        value={selectedId}
        onChange={(event) => choose(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {options}
      </select>
    </div>
  );
}

function persistSelection(babyId: string) {
  localStorage.setItem(SELECTED_BABY_STORAGE_KEY, babyId);
  document.cookie = `${SELECTED_BABY_COOKIE}=${encodeURIComponent(babyId)}; path=/; max-age=31536000; samesite=lax`;
}

function readCookie(name: string) {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}
