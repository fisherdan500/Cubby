import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type ServiceWorkerEvent = {
  oldSubscription: { options: { applicationServerKey: ArrayBuffer } } | null;
  waitUntil(promise: Promise<unknown>): void;
};

type ServiceWorkerHandler = (event: ServiceWorkerEvent) => void;

describe("service-worker push subscription recovery", () => {
  it("fetches the VAPID key and replaces a subscription when the browser omits the old subscription", async () => {
    const publicKey = "BGcWrZudyR-fX1dkOamQfe7Wwo1aiN6bFkU-JWxjhfi9B4cfZj6E727glvvrh_t8NV4ABux6rzWS3Cg5ytwfEUg";
    const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    const handlers = new Map<string, ServiceWorkerHandler>();
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://push.example.test/replacement",
      toJSON: () => ({ keys: { p256dh: "replacement-p256dh", auth: "replacement-auth" } })
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/notifications/vapid-key") {
        return {
          ok: true,
          json: async () => ({ data: { enabled: true, reason: null, publicKey } })
        };
      }
      if (url === "/api/notifications/subscribe") return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected_fetch:${url}:${init?.method ?? "GET"}`);
    });

    runInNewContext(source, {
      ArrayBuffer,
      URL,
      Uint8Array,
      atob,
      caches: {},
      fetch,
      self: {
        addEventListener: (name: string, handler: ServiceWorkerHandler) => handlers.set(name, handler),
        clients: {},
        location: { origin: "https://cubby.example.test" },
        registration: { pushManager: { subscribe } },
        skipWaiting: vi.fn()
      }
    });

    const handler = handlers.get("pushsubscriptionchange");
    expect(handler).toBeDefined();
    let completion: Promise<unknown> | undefined;
    handler?.({
      oldSubscription: null,
      waitUntil: (promise) => {
        completion = promise;
      }
    });
    await completion;

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/notifications/vapid-key", {
      cache: "no-store",
      credentials: "include"
    });
    expect(subscribe).toHaveBeenCalledOnce();
    const subscribeOptions = subscribe.mock.calls[0]?.[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: ArrayBuffer;
    };
    expect(subscribeOptions.userVisibleOnly).toBe(true);
    expect(publicKey).toHaveLength(87);
    expect(publicKey).toContain("-");
    expect(publicKey).toContain("_");
    expect(Array.from(new Uint8Array(subscribeOptions.applicationServerKey))).toEqual([
      4, 103, 22, 173, 155, 157, 201, 31, 159, 95, 87, 100, 57, 169, 144, 125, 238, 214, 194, 141, 90, 136,
      222, 155, 22, 69, 62, 37, 108, 99, 133, 248, 189, 7, 135, 31, 102, 62, 132, 239, 110, 224, 150, 251,
      235, 135, 251, 124, 53, 94, 0, 6, 236, 122, 175, 53, 146, 220, 40, 57, 202, 220, 31, 17, 72
    ]);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        endpoint: "https://push.example.test/replacement",
        keys: { p256dh: "replacement-p256dh", auth: "replacement-auth" }
      })
    });
  });

  it.each(["non-2xx response", "network rejection"] as const)(
    "removes a replacement subscription after a %s",
    async (failure) => {
      const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
      const handlers = new Map<string, ServiceWorkerHandler>();
      const unsubscribe = vi.fn().mockResolvedValue(true);
      const subscribe = vi.fn().mockResolvedValue({
        endpoint: "https://push.example.test/rejected",
        toJSON: () => ({ keys: { p256dh: "rejected-p256dh", auth: "rejected-auth" } }),
        unsubscribe
      });
      const fetch = vi.fn(async (url: string) => {
        if (url === "/api/notifications/vapid-key") {
          return {
            ok: true,
            json: async () => ({ data: { enabled: true, reason: null, publicKey: "AQID" } })
          };
        }
        if (url === "/api/notifications/subscribe") {
          if (failure === "network rejection") throw new Error("network_unavailable");
          return { ok: false, json: async () => ({}) };
        }
        throw new Error(`unexpected_fetch:${url}`);
      });

      runInNewContext(source, {
        ArrayBuffer,
        URL,
        Uint8Array,
        atob,
        caches: {},
        fetch,
        self: {
          addEventListener: (name: string, handler: ServiceWorkerHandler) => handlers.set(name, handler),
          clients: {},
          location: { origin: "https://cubby.example.test" },
          registration: { pushManager: { subscribe } },
          skipWaiting: vi.fn()
        }
      });

      let completion: Promise<unknown> | undefined;
      handlers.get("pushsubscriptionchange")?.({
        oldSubscription: null,
        waitUntil: (promise) => {
          completion = promise;
        }
      });
      await completion;

      expect(unsubscribe).toHaveBeenCalledOnce();
    }
  );

  it("reuses the prior application server key without fetching the configured key", async () => {
    const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    const handlers = new Map<string, ServiceWorkerHandler>();
    const applicationServerKey = Uint8Array.from([7, 8, 9]).buffer;
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://push.example.test/replacement",
      toJSON: () => ({ keys: { p256dh: "replacement-p256dh", auth: "replacement-auth" } }),
      unsubscribe: vi.fn().mockResolvedValue(true)
    });
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/notifications/subscribe") return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected_fetch:${url}`);
    });

    runInNewContext(source, {
      ArrayBuffer,
      URL,
      Uint8Array,
      atob,
      caches: {},
      fetch,
      self: {
        addEventListener: (name: string, handler: ServiceWorkerHandler) => handlers.set(name, handler),
        clients: {},
        location: { origin: "https://cubby.example.test" },
        registration: { pushManager: { subscribe } },
        skipWaiting: vi.fn()
      }
    });

    let completion: Promise<unknown> | undefined;
    handlers.get("pushsubscriptionchange")?.({
      oldSubscription: { options: { applicationServerKey } },
      waitUntil: (promise) => {
        completion = promise;
      }
    });
    await completion;

    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/notifications/subscribe");
  });
});
