import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  );
}
