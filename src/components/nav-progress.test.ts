import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A click on a server-rendered route costs a round trip before anything on screen changes. Next 14
// renders nothing in that gap unless a route has a loading boundary, so without one the app looks
// like it ignored the click and a parent taps again. These assertions pin the feedback, not the
// speed: they are what stops the regression that made navigation feel broken.

describe("navigation acknowledges a click before the server answers", () => {
  it("gives every /app route a loading boundary so the gap is never blank", () => {
    // Next resolves the closest loading.tsx above the target segment, so one at the /app root covers
    // every screen beneath it: Log Entry, Moments, Calendar, Reports, Full Log and Settings.
    const source = readFileSync("src/app/app/loading.tsx", "utf8");
    expect(source).toContain("export default function");
    // Pending UI must carry the shell's own skeleton, not a bare spinner, or the page appears to
    // empty out on every navigation.
    expect(source).toContain("animate-pulse");
    expect(source).toContain("aria-hidden");
  });

  it("marks the tab being navigated to, so the click has a visible target", () => {
    const source = readFileSync("src/components/nav-progress.tsx", "utf8");
    expect(source).toContain('"use client"');
    // useLinkStatus is Next 15+. On 14 the equivalent signal is the pathname the user asked for,
    // tracked against the pathname actually rendered.
    expect(source).toContain("useTransition");
    expect(source).toContain("aria-busy");
  });

  it("keeps the pending tab readable to assistive technology, not colour alone", () => {
    const source = readFileSync("src/components/nav-progress.tsx", "utf8");
    expect(source).toMatch(/aria-busy=\{[^}]*pending/);
    expect(source).toContain("sr-only");
  });
});

describe("the tabs a parent moves between are prefetched", () => {
  it("prefetches from the shared nav link, so every tab benefits", () => {
    // prefetch belongs on NavLink rather than each call site: putting it at the one place every tab
    // routes through is what stops a new tab being added later without it.
    const source = readFileSync("src/components/nav-progress.tsx", "utf8");
    expect(source).toContain("prefetch");
  });

  it("routes the desktop primary nav through the prefetching link", () => {
    const source = readFileSync("src/components/app-shell.tsx", "utf8");
    expect(source).toMatch(/primaryNav\.map[\s\S]{0,400}<NavLink/);
    // The old plain Link would silently lose both prefetch and the pending state.
    expect(source).not.toMatch(/primaryNav\.map[\s\S]{0,400}<Link\b/);
  });

  it("routes the phone bottom tabs through the prefetching link", () => {
    const source = readFileSync("src/components/mobile-bottom-nav.tsx", "utf8");
    expect(source).toMatch(/mobileNav\.map[\s\S]{0,600}<NavLink/);
    expect(source).not.toMatch(/mobileNav\.map[\s\S]{0,600}<Link\b/);
  });
});
