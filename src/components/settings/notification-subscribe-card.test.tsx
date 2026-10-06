// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationSubscribeCard } from "@/components/settings/notification-subscribe-card";

const subscription = { endpoint: "https://push.example/device" };
const getSubscription = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    json: vi.fn().mockResolvedValue({
      data: { enabled: true, reason: null, publicKey: "AQID" }
    })
  }));
  vi.stubGlobal("Notification", { permission: "granted" });
  Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false })
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ pushManager: { getSubscription } })
    }
  });
  getSubscription.mockResolvedValue(subscription);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NotificationSubscribeCard", () => {
  it("describes device registration without claiming that an unsaved or inactive preference will deliver", async () => {
    render(<NotificationSubscribeCard />);

    expect(screen.getByText("Register this device so it can receive browser notifications. Cubby sends nothing unless an active saved preference allows it.")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByText("This device is registered for browser notifications. Cubby sends nothing unless an active saved preference allows it.")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Unregister this device" })).not.toBeNull();
    expect(screen.queryByText("Notifications are on for this device.")).toBeNull();
  });
});
