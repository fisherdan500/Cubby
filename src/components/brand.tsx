import Image from "next/image";
import { cn } from "@/lib/utils";

const markSizes = {
  sm: { pixels: 40, className: "h-10 w-10", word: "text-xl" },
  md: { pixels: 56, className: "h-14 w-14", word: "text-2xl" },
  lg: { pixels: 72, className: "h-[72px] w-[72px]", word: "text-3xl" },
  xl: { pixels: 96, className: "h-24 w-24", word: "text-4xl" }
} as const;

export type BrandSize = keyof typeof markSizes;

export function BrandMark({
  size = "md",
  field = false,
  priority = false,
  className
}: {
  size?: BrandSize;
  field?: boolean;
  priority?: boolean;
  className?: string;
}) {
  const sizing = markSizes[size];
  return (
    <Image
      src={field ? "/icon.svg" : "/brand/cubby-mark.svg"}
      alt=""
      width={sizing.pixels}
      height={sizing.pixels}
      priority={priority}
      className={cn("shrink-0 object-contain", sizing.className, className)}
    />
  );
}

export function BrandLockup({
  size = "md",
  orientation = "horizontal",
  tagline,
  field = false,
  priority = false,
  className
}: {
  size?: BrandSize;
  orientation?: "horizontal" | "vertical";
  tagline?: string;
  field?: boolean;
  priority?: boolean;
  className?: string;
}) {
  const sizing = markSizes[size];
  return (
    <span
      className={cn(
        "inline-flex items-center",
        orientation === "vertical" ? "flex-col gap-2 text-center" : "gap-3 text-left",
        className
      )}
    >
      <BrandMark size={size} field={field} priority={priority} />
      <span>
        <span className={cn("block font-editorial font-bold leading-none text-foreground", sizing.word)}>Cubby</span>
        {tagline ? <span className="mt-1 block text-xs font-semibold text-muted-foreground">{tagline}</span> : null}
      </span>
    </span>
  );
}
