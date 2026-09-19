import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/history",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("babyId=baby-1")
}));

vi.stubGlobal("React", React);

describe("HeaderBabySelector", () => {
  it("can shrink inside the narrow mobile header when a baby has a long name", async () => {
    const { HeaderBabySelector } = await import("@/components/header-baby-selector");
    const html = renderToStaticMarkup(
      React.createElement(HeaderBabySelector, {
        data: {
          selectedBabyId: "baby-1",
          babies: [
            {
              id: "baby-1",
              name: "Synthetic Baby One With A Deliberately Long Name",
              ageLabel: "6 months",
              inactive: false
            }
          ]
        }
      })
    );

    expect(html).toContain("relative min-w-0 flex-1");
    expect(html).toContain("sm:flex-none");
    expect(html).toContain("focus-within:ring-2");
    expect(html).toContain("focus-within:ring-ring");
  });

  it("renders the phone line as one truncating line, switchable only when there is another baby", async () => {
    const { HeaderBabySelector } = await import("@/components/header-baby-selector");
    const baby = (id: string, name: string) => ({ id, name, ageLabel: "6 months", inactive: false });
    const single = renderToStaticMarkup(
      React.createElement(HeaderBabySelector, { variant: "line", data: { selectedBabyId: "baby-1", babies: [baby("baby-1", "Synthetic One")] } })
    );
    expect(single).toContain("min-w-0 truncate");
    expect(single).toContain("Synthetic One");
    expect(single).toContain("6 months");
    expect(single).not.toContain("<select");

    const several = renderToStaticMarkup(
      React.createElement(HeaderBabySelector, {
        variant: "line",
        data: { selectedBabyId: "baby-1", babies: [baby("baby-1", "Synthetic One"), baby("baby-2", "Synthetic Two")] }
      })
    );
    expect(several).toContain('aria-label="Select baby"');
    expect(several).toContain("Synthetic Two");
  });
});
