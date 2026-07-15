import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ZeroActiveBabies } from "@/components/dashboard/zero-active-babies";

describe("ZeroActiveBabies", () => {
  beforeAll(() => vi.stubGlobal("React", React));

  it("offers lifecycle management only to members with baby.manage", () => {
    const html = renderToStaticMarkup(React.createElement(ZeroActiveBabies, { canManageBabies: true }));

    expect(html).toContain("Reactivate a baby or add a new one");
    expect(html).toContain("Manage babies");
    expect(html).toContain('href="/app/babies"');
  });

  it("offers historical review instead of an unauthorized management action", () => {
    const html = renderToStaticMarkup(React.createElement(ZeroActiveBabies, { canManageBabies: false }));

    expect(html).toContain("You can still review historical activity");
    expect(html).toContain("View history");
    expect(html).toContain('href="/app/history"');
    expect(html).not.toContain("Manage babies");
  });
});
