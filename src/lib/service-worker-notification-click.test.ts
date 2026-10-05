import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type NotificationClickEvent = {
  notification: {
    data?: { url?: string };
    close(): void;
  };
  waitUntil(promise: Promise<unknown>): void;
};

type NotificationClickHandler = (event: NotificationClickEvent) => void;

type WindowClient = {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<WindowClient | null>;
};

function notificationClickHarness(windows: WindowClient[] = []) {
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, NotificationClickHandler>();
  const openWindow = vi.fn().mockResolvedValue(null);

  runInNewContext(source, {
    ArrayBuffer,
    URL,
    Uint8Array,
    atob,
    caches: {},
    fetch: vi.fn(),
    self: {
      addEventListener: (name: string, handler: NotificationClickHandler) => handlers.set(name, handler),
      clients: {
        matchAll: vi.fn().mockResolvedValue(windows),
        openWindow
      },
      location: { origin: "https://cubby.example.test" },
      registration: {},
      skipWaiting: vi.fn()
    }
  });

  return { handler: handlers.get("notificationclick"), openWindow };
}

async function clickNotification(handler: NotificationClickHandler, url: string) {
  let completion: Promise<unknown> | undefined;
  handler({
    notification: {
      data: { url },
      close: vi.fn()
    },
    waitUntil: (promise) => {
      completion = promise;
    }
  });
  expect(completion).toBeDefined();
  await completion;
}

describe("service-worker notification click navigation", () => {
  it("does not open a cross-origin target when no Cubby window is already open", async () => {
    const { handler, openWindow } = notificationClickHarness();
    expect(handler).toBeDefined();

    await clickNotification(handler!, "https://attacker.example/phishing");

    expect(openWindow).not.toHaveBeenCalled();
  });

  it.each([
    "//attacker.example/phishing",
    "http://cubby.example.test/app/moments",
    "https://cubby.example.test:444/app/moments",
    "https://cubby.example.test@attacker.example/phishing",
    "javascript:alert(1)",
    "http://["
  ])("fulfills without opening the unsafe fallback target %s", async (target) => {
    const { handler, openWindow } = notificationClickHarness();

    await clickNotification(handler!, target);

    expect(openWindow).not.toHaveBeenCalled();
  });

  it.each([
    "/app/moments?post=post-1",
    "https://cubby.example.test/app/activities/activity-1"
  ])("still opens the same-origin target %s", async (target) => {
    const { handler, openWindow } = notificationClickHarness();

    await clickNotification(handler!, target);

    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(target);
  });

  it("preserves navigation through an existing same-origin Cubby window", async () => {
    const focusedWindow = { focus: vi.fn().mockResolvedValue(null), url: "https://cubby.example.test/app/moments" };
    const existingWindow: WindowClient = {
      focus: vi.fn().mockResolvedValue(null),
      navigate: vi.fn().mockResolvedValue(focusedWindow),
      url: "https://cubby.example.test/app"
    };
    const target = "https://attacker.example/existing-window-behavior";
    const { handler, openWindow } = notificationClickHarness([existingWindow]);

    await clickNotification(handler!, target);

    expect(existingWindow.navigate).toHaveBeenCalledWith(target);
    expect(focusedWindow.focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
