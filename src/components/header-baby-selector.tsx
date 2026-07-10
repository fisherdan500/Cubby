"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { ActivityArtwork } from "@/components/activity-artwork";
import {
  SELECTED_BABY_COOKIE,
  SELECTED_BABY_STORAGE_KEY,
  type HeaderBabySelectorData
} from "@/lib/baby-selector";

export function HeaderBabySelector({ data }: { data: HeaderBabySelectorData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState(data.selectedBabyId);
  const babyIds = useMemo(() => new Set(data.babies.map((baby) => baby.id)), [data.babies]);
  const selectedBaby = data.babies.find((baby) => baby.id === selectedId) ?? data.babies[0];
  const activeTimerType = selectedId === data.selectedBabyId ? data.activeTimerType : undefined;

  const replaceBabyId = useCallback(
    (nextBabyId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("babyId", nextBabyId);
      router.replace(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    setSelectedId(data.selectedBabyId);
  }, [data.selectedBabyId]);

  useEffect(() => {
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
  }, [babyIds, data.selectedBabyId, replaceBabyId, searchParams]);

  function choose(nextBabyId: string) {
    setSelectedId(nextBabyId);
    persistSelection(nextBabyId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("babyId", nextBabyId);
    router.push(`${pathname}?${params.toString()}`);
  }

  if (!selectedBaby) return null;

  return (
    <div className="relative">
      <div className="flex min-h-12 items-center gap-2 rounded-full border border-primary-foreground/25 bg-card px-3 py-1.5 text-left font-bold text-card-foreground shadow-soft">
        {activeTimerType ? <ActivityArtwork type={activeTimerType} size="xs" /> : null}
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <span className="max-w-32 truncate text-sm sm:max-w-40 sm:text-base">{selectedBaby.name}</span>
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
        {data.babies.map((baby) => (
          <option key={baby.id} value={baby.id}>
            {baby.name} - {baby.ageLabel}
          </option>
        ))}
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
