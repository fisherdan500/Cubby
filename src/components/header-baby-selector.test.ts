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
});
