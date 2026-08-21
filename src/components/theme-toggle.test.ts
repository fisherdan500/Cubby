import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));

import { ThemeToggle } from "@/components/theme-toggle";

globalThis.React = React;

describe("ThemeToggle", () => {
  it("renders a labeled utility button with a 44 by 44 CSS-pixel minimum target", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle));

    expect(html).toContain('aria-label="Toggle dark mode"');
    expect(html).toContain("h-11");
    expect(html).toContain("min-h-11");
    expect(html).toContain("w-11");
  });
});
