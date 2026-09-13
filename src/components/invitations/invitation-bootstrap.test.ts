import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  events: [] as string[]
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(value: T) => [value, vi.fn()] as const
  };
});

import { InvitationBootstrap } from "@/components/invitations/invitation-bootstrap";

let originalLocation: PropertyDescriptor | undefined;
let originalHistory: PropertyDescriptor | undefined;
let originalSessionStorage: PropertyDescriptor | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  mocks.effects.length = 0;
  mocks.events.length = 0;
  originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://cubby.test/invite#c=fragment-secret" } });
  Object.defineProperty(globalThis, "history", { configurable: true, value: { replaceState: () => mocks.events.push("strip") } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => "partition", setItem: () => {} } });
  globalThis.fetch = vi.fn(async () => {
    mocks.events.push("claim");
    return { ok: true, json: async () => ({ ok: true, data: { status: "claimed" } }) } as Response;
  });
});

afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  if (originalHistory) Object.defineProperty(globalThis, "history", originalHistory);
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  globalThis.fetch = originalFetch;
});

describe("InvitationBootstrap", () => {
  it("strips the fragment before it claims and renders any token-bearing state", async () => {
    InvitationBootstrap();
    const cleanup = mocks.effects[0]?.();
    await vi.waitFor(() => expect(mocks.events).toEqual(["strip", "claim"]));
    cleanup?.();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/invitations/claim",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("fragment-secret") })
    );
  });
});
