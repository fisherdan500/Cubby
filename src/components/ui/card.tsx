import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-w-0 rounded-lg border border-border/90 bg-card p-4 shadow-soft", className)}
      {...props}
    />
  );
}
