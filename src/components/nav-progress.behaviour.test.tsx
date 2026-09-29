// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavLink, NavPendingProvider } from "@/components/nav-progress";

// The source assertions next door prove the wiring exists. These prove it behaves: a click marks the
// tab pending, and arriving at the destination clears it. Without this, a regression that renders
// prefetch and aria-busy but never flips the state would still pass.

let pathname = "/app";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ children, prefetch, ...rest }: Record<string, unknown> & { children: React.ReactNode }) => {
    // Render prefetch as an attribute so the test can see Next received it.
    return (
      <a {...(rest as Record<string, unknown>)} data-prefetch={String(prefetch)}>
        {children}
      </a>
    );
  }
}));

beforeEach(() => {
  pathname = "/app";
});
afterEach(() => {
  // Vitest has no global testing-library cleanup here, so without this each render stacks up and
  // the next query finds several copies of the same link.
  cleanup();
  vi.clearAllMocks();
});

describe("a clicked tab reports itself as pending", () => {
  it("is not busy before the click", () => {
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
      </NavPendingProvider>
    );
    expect(screen.getByRole("link", { name: "Moments" }).getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("becomes busy and announces itself the moment it is clicked", () => {
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Moments/ }));
    const link = screen.getByRole("link", { name: /Moments/ });
    expect(link.getAttribute("aria-busy")).toBe("true");
    // Spoken, not colour alone.
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("marks only the tab that was clicked", () => {
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
        <NavLink href="/app/calendar">Calendar</NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Moments/ }));
    expect(screen.getByRole("link", { name: /Moments/ }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("link", { name: "Calendar" }).getAttribute("aria-busy")).toBeNull();
  });

  it("marks the clicked tab pending even when it carries a baby query", () => {
    pathname = "/app/moments";
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments?babyId=b1">Moments</NavLink>
        <NavLink href="/app/calendar">Calendar</NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Moments/ }));
    // The href stored on click is the exact string compared, so a baby-scoped tab still marks.
    expect(screen.getByRole("link", { name: /Moments/ }).getAttribute("aria-busy")).toBe("true");
  });

  it("asks Next to prefetch", () => {
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
      </NavPendingProvider>
    );
    expect(screen.getByRole("link", { name: "Moments" }).getAttribute("data-prefetch")).toBe("true");
  });

  it("runs the caller's own click work as well as marking pending", () => {
    const onNavigate = vi.fn();
    render(
      <NavPendingProvider>
        <NavLink href="/app/history" onNavigate={onNavigate}>
          Full Log
        </NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Full Log/ }));
    // The phone sheet closes through this callback; losing it would leave the sheet over the page.
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("the pending mark is released when the destination arrives", () => {
  it("clears once the rendered pathname becomes the requested one", () => {
    // The mark must last exactly as long as the wait. If it never clears, every tab visited stays
    // marked busy for the rest of the session and the indicator becomes meaningless.
    const view = render(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Moments/ }));
    expect(screen.getByRole("link", { name: /Moments/ }).getAttribute("aria-busy")).toBe("true");

    // The server answered and Next rendered the new route: usePathname now reports the destination.
    pathname = "/app/moments";
    view.rerender(
      <NavPendingProvider>
        <NavLink href="/app/moments">Moments</NavLink>
      </NavPendingProvider>
    );
    expect(screen.getByRole("link", { name: "Moments" }).getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("clears a baby-scoped href once its pathname is rendered", () => {
    // The rendered pathname never carries the query string, so clearing must be driven by the
    // pathname changing rather than by matching the href the user clicked.
    pathname = "/app";
    const view = render(
      <NavPendingProvider>
        <NavLink href="/app/calendar?babyId=b1">Calendar</NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: /Calendar/ }));
    expect(screen.getByRole("link", { name: /Calendar/ }).getAttribute("aria-busy")).toBe("true");

    pathname = "/app/calendar";
    view.rerender(
      <NavPendingProvider>
        <NavLink href="/app/calendar?babyId=b1">Calendar</NavLink>
      </NavPendingProvider>
    );
    expect(screen.getByRole("link", { name: "Calendar" }).getAttribute("aria-busy")).toBeNull();
  });
});

describe("the pending tab is visibly marked, not only announced", () => {
  it("applies the caller's pending class while waiting", () => {
    // aria-busy serves assistive technology. A sighted parent needs the tab itself to change, which is
    // the whole point of the fix: the click must look acknowledged.
    render(
      <NavPendingProvider>
        <NavLink href="/app/moments" className="tab-base" pendingClassName="tab-pending">
          Moments
        </NavLink>
      </NavPendingProvider>
    );
    const before = screen.getByRole("link", { name: "Moments" });
    expect(before.className).toContain("tab-base");
    expect(before.className).not.toContain("tab-pending");

    fireEvent.click(before);
    expect(screen.getByRole("link", { name: /Moments/ }).className).toContain("tab-pending");
  });

  it("falls back to a dimmed state when the caller gives no pending class", () => {
    render(
      <NavPendingProvider>
        <NavLink href="/app/reports" className="tab-base">
          Reports
        </NavLink>
      </NavPendingProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: "Reports" }));
    // Without a fallback, a nav link added later without pendingClassName would show nothing at all.
    expect(screen.getByRole("link", { name: /Reports/ }).className).toContain("opacity-70");
  });
});
