import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("calendar interaction contracts", () => {
  it("fits the month to the screen instead of scrolling it sideways", () => {
    expect(source).not.toContain("min-w-[860px]");
    expect(source).not.toContain("CalendarScrollPair");
    expect(source).toContain('className="grid grid-cols-7 border-l border-border"');
  });

  it("provides 44px minimum month, day, and drawer-close targets", () => {
    expect(source).not.toMatch(/\bh-9 w-9\b|\bh-7 min-w-7\b|\bh-10 w-10\b/);
    expect(source.match(/h-11 w-11/g)?.length).toBeGreaterThanOrEqual(4);
    // A phone day cell is one full-width target at least 56px tall; from md up the date is 44px.
    expect(source).toContain('className="flex min-h-14 w-full');
    expect(source).toContain("md:h-11 md:min-h-0 md:w-auto md:min-w-11");
    expect(source).toContain('className="block min-h-11');
    expect(source).toContain('className="mt-2 hidden min-h-11');
    expect(source).toContain('className="flex min-h-11 items-center');
  });

  it("matches the mobile and desktop AppShell sticky offsets", () => {
    // A phone has no AppShell header, so the month bar pins to the top edge; desktop pins below its 5rem header.
    expect(source).toContain("sticky top-0 z-10 md:-mt-5 md:top-20");
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

  it("keeps inactive babies historical-only", () => {
    expect(source).toContain("const canAddEvent = !calendar.baby?.inactiveAt");
    expect(source).toContain('canAddEvent && !calendar.selected && searchParams.new !== "1"');
    expect(source).toContain('calendar.selected || (searchParams.new === "1" && canAddEvent)');
    expect(source).toContain("canAddEvent ? (");
  });

  it("keeps calendar contact input optional until the calendar page exposes household contacts", () => {
    expect(source).not.toContain('name="contactIds"');
  });
});