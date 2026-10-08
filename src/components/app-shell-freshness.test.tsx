import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "America/New_York" } }));
import { AppShell } from "@/components/app-shell";
import { PageFreshness } from "@/components/app-freshness";

function confirmations(node: ReactNode): Record<string, unknown>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    if (child.type === PageFreshness) return [child.props];
    return confirmations(child.props.children);
  });
}
afterEach(() => vi.useRealTimers());
it("each server shell render produces a new token and completion instant after page loaders", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  async function page() {
    await Promise.resolve();
    vi.setSystemTime(new Date("2026-10-07T12:00:03.000Z"));
    return AppShell({ title: "Log", userName: "Fixture", children: "loaded" });
  }
  const first = confirmations(await page());
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ confirmedAt: "2026-10-07T12:00:03.000Z", timeZone: "America/New_York", token: expect.any(String) });
  expect(confirmations(await page())[0].token).not.toBe(first[0].token);
});
