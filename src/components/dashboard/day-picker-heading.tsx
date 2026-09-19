"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * The day heading doubles as a way to jump to any date. It uses the platform's own date picker rather
 * than a custom calendar: on a phone that is the familiar native sheet, it is accessible for free,
 * and it matches the native-first stance the activity forms already take (DEC-PROD-400).
 *
 * The date input is laid invisibly over the heading so a tap lands on it directly - the one approach
 * that reliably opens the picker on iOS, where programmatic focus does not. Where showPicker() exists
 * (desktop browsers, where clicking a date field does not open its calendar) it is called as well.
 */
export function DayPickerHeading({
  babyId,
  dateKey,
  maxDateKey,
  heading,
  subheading
}: {
  babyId: string;
  dateKey: string;
  maxDateKey: string;
  heading: string;
  subheading?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);

  return (
    // The input is invisible, so its own focus outline is too; the heading shows the ring instead.
    <div className="relative min-w-0 flex-1 rounded-lg text-center transition hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <p className="truncate text-base font-black leading-tight">{heading}</p>
      {subheading ? <p className="truncate text-xs font-semibold text-muted-foreground">{subheading}</p> : null}
      <input
        ref={input}
        type="date"
        aria-label="Choose a date"
        value={dateKey}
        max={maxDateKey}
        onClick={() => {
          try {
            input.current?.showPicker?.();
          } catch {
            // Some browsers refuse showPicker outside a direct gesture; the tap itself still opens it.
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          if (next && next !== dateKey) router.push(`/app?babyId=${encodeURIComponent(babyId)}&date=${next}`);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}
