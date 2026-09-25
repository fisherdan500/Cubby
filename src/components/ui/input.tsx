import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 min-w-0 w-full rounded-lg border border-control bg-card px-3 py-2 text-base outline-none sm:text-sm transition focus:border-ring focus:ring-4 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  );
}

// Takes a ref so a caller can focus it within a tap, which is when a phone raises its keyboard.
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-24 w-full rounded-lg border border-control bg-card px-3 py-2 text-base outline-none sm:text-sm transition focus:border-ring focus:ring-4 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  );
});

/** Native select styled like Input: same height, focus ring, and 16px mobile text so iOS does not zoom. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "min-h-11 min-w-0 w-full rounded-lg border border-control bg-card px-3 py-2 text-base font-semibold outline-none sm:text-sm transition focus:border-ring focus:ring-4 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  );
}
