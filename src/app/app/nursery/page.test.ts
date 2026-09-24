import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  })
}));

vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));

import NurseryPage from "@/app/app/nursery/page";

beforeEach(() => {
  navigation.redirect.mockClear();
});

describe("retired Nursery screen", () => {
  it("sends an old link or home-screen shortcut to Log Entry, keeping the selected baby", () => {
    expect(() => NurseryPage({ searchParams: { babyId: "baby 1" } })).toThrow("NEXT_REDIRECT:/app?babyId=baby+1");
  });

  it("sends a link without a baby to Log Entry", () => {
    expect(() => NurseryPage({ searchParams: {} })).toThrow("NEXT_REDIRECT:/app");
  });
});
