"use client";

import { useEffect } from "react";

export function CalendarFocusRestore({ selector }: { selector: string }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selector]);

  return null;
}
