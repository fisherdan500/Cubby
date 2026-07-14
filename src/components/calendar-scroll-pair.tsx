"use client";

import { type ReactNode, useRef } from "react";

export function CalendarScrollPair({ weekdays, days }: { weekdays: ReactNode; days: ReactNode }) {
  const weekdaysRef = useRef<HTMLDivElement>(null);
  const daysRef = useRef<HTMLElement>(null);
  let syncing = false;

  function synchronize(source: HTMLElement, target: HTMLElement | null) {
    if (!target || syncing || target.scrollLeft === source.scrollLeft) return;
    syncing = true;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncing = false;
    });
  }

  return (
    <>
      <div
        ref={weekdaysRef}
        className="overflow-x-auto border-b border-border bg-background"
        onScroll={(event) => synchronize(event.currentTarget, daysRef.current)}
        data-calendar-scroll="weekdays"
      >
        {weekdays}
      </div>
      <section
        ref={daysRef}
        className="overflow-x-auto"
        onScroll={(event) => synchronize(event.currentTarget, weekdaysRef.current)}
        data-calendar-scroll="days"
      >
        {days}
      </section>
    </>
  );
}
