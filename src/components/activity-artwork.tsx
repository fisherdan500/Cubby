"use client";

import Image from "next/image";
import { useState } from "react";
import {
  Bath,
  Bed,
  Droplets,
  Milk,
  NotebookText,
  Package,
  Pill,
  Plus,
  Ruler,
  Smile,
  Syringe,
  Trophy,
  Wand2
} from "lucide-react";
import { activityVisuals, type ActivityTypeName } from "@/domain/activity";
import { cn } from "@/lib/utils";

const fallbackIcons: Record<ActivityTypeName, React.ElementType> = {
  feeding: Milk,
  diaper: Droplets,
  sleep: Bed,
  pumping: Milk,
  medicine: Pill,
  measurement: Ruler,
  milestone: Trophy,
  note: NotebookText,
  bath: Bath,
  play: Wand2,
  mood: Smile,
  supplement: Plus,
  vaccine: Syringe,
  milk_inventory: Package
};

const sizes = {
  xs: { frame: "h-8 w-8", image: 28, icon: "h-4 w-4" },
  sm: { frame: "h-10 w-10", image: 34, icon: "h-5 w-5" },
  md: { frame: "h-12 w-12", image: 42, icon: "h-6 w-6" },
  lg: { frame: "h-16 w-16", image: 56, icon: "h-7 w-7" },
  xl: { frame: "h-20 w-20", image: 72, icon: "h-9 w-9" }
} as const;

export type ActivityArtworkSize = keyof typeof sizes;

export function ActivityArtwork({
  type,
  size = "md",
  framed = true,
  className
}: {
  type: ActivityTypeName;
  size?: ActivityArtworkSize;
  framed?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const visual = activityVisuals[type];
  const Fallback = fallbackIcons[type];
  const sizing = sizes[size];

  return (
    <span
      className={cn(
        "activity-artwork inline-flex shrink-0 items-center justify-center",
        sizing.frame,
        framed && `rounded-full border border-black/5 shadow-soft ${visual.toneClass}`,
        className
      )}
      aria-hidden="true"
    >
      {failed ? (
        <Fallback className={sizing.icon} />
      ) : (
        <Image
          src={visual.artwork}
          alt=""
          width={sizing.image}
          height={sizing.image}
          className="h-[88%] w-[88%] object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
