import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("calendar interaction contracts", () => {
  it("keeps weekday and calendar scrolling synchronized", () => {
    expect(source).toContain("CalendarScrollPair");
  });

  it("provides 44px minimum month, day, and drawer-close targets", () => {
    expect(source).not.toMatch(/\bh-9 w-9\b|\bh-7 min-w-7\b|\bh-10 w-10\b/);
    expect(source.match(/h-11 w-11/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('className="block min-h-11');
    expect(source).toContain('className="mt-2 flex min-h-11');
    expect(source).toContain('className="flex min-h-11 items-center');
  });

  it("matches the mobile and desktop AppShell sticky offsets", () => {
    expect(source).toContain("top-16");
    expect(source).toContain("md:top-20");
  });

  it("preserves an allowlisted focus-restoration opener through drawer routes", () => {
    expect(source).toContain("opener?: string");
    expect(source).toContain("calendarOpenerSelector");
    expect(source).toContain("CalendarFocusRestore");
    expect(source).toContain("data-calendar-event");
    expect(source).toContain("data-calendar-more");
    expect(source).toContain("data-calendar-activity-day");
    expect(source).toContain(
      "const returnTo = calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate, opener });"
    );
    expect(source).toContain('/^[a-z0-9-]+$/i');
  });
});