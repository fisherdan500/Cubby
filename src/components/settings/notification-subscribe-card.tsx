"use client";

import { useEffect, useState } from "react";

/**
 * Turning on notifications for this phone.
 *
 * Three things have to be true before a browser will subscribe, and each failure gets its own
 * plain sentence rather than a dead button:
 *
 *  - the page is a secure context (https, or localhost in development);
 *  - the install has VAPID keys, so there is something to subscribe to;
 *  - on an iPhone, Cubby has been added to the Home Screen and opened from there. Safari grants
 *    push only to an installed web app; in a browser tab the permission prompt never appears, and
 *    a button that silently does nothing is worse than one that explains itself.
 *
 * Permission is requested from a real tap. Browsers require a user gesture, and asking on page
 * load is how a household ends up permanently blocked.
 */

type KeyResponse = { enabled: boolean; reason: string | null; publicKey: string | null };

type State =
  | { step: "checking" }
  | { step: "unsupported"; reason: string }
  | { step: "needs-install" }
  | { step: "off" }
  | { step: "on" }
  | { step: "blocked" }
  | { step: "working" }
  | { step: "failed"; reason: string };

/** base64url to the bytes the Push API wants, in a buffer it will accept. */
function applicationServerKey(base64Url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  // A plain ArrayBuffer rather than a view: the Push API types reject a Uint8Array whose buffer
  // could in principle be shared.
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

/** True when the page is running as an installed app rather than a browser tab. */
function isInstalled(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS reports installation only through this older property.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function NotificationSubscribeCard() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // A named async function called from the effect, which is how every other component in this
    // codebase runs async work on mount. An inline async IIFE hides its calls from the operation
    // registry's client-binding analysis, which then reports them as undeclared.
    async function check() {
      // Feature-detected through the property rather than `"PushManager" in window`: a bare
      // `window` operand is a global value reference, which the operation registry reads as an
      // undeclared client binding. Reading the property keeps `window` as a property base.
      if (!("serviceWorker" in navigator) || typeof window.PushManager === "undefined") {
        if (!cancelled) setState({ step: "unsupported", reason: "This browser cannot show notifications." });
        return;
      }
      if (!window.isSecureContext) {
        if (!cancelled) {
          setState({
            step: "unsupported",
            reason: "Notifications need a secure (https) address. Open Cubby at its https address and try again."
          });
        }
        return;
      }
      // An iPhone will not subscribe from a Safari tab, so say so before offering a button.
      if (isIos() && !isInstalled()) {
        if (!cancelled) setState({ step: "needs-install" });
        return;
      }

      let config: KeyResponse | undefined;
      try {
        const response = await fetch("/api/notifications/vapid-key", { cache: "no-store" });
        const body = (await response.json()) as { data?: KeyResponse } | null;
        config = body?.data;
      } catch {
        config = undefined;
      }
      if (!config?.enabled || !config.publicKey) {
        if (!cancelled) {
          setState({
            step: "unsupported",
            reason: config?.reason
              ? `Notifications are not set up on this server (${config.reason}).`
              : "Notifications are not set up on this server."
          });
        }
        return;
      }
      if (!cancelled) setPublicKey(config.publicKey);

      if (Notification.permission === "denied") {
        if (!cancelled) setState({ step: "blocked" });
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setState({ step: existing ? "on" : "off" });
      } catch {
        if (!cancelled) setState({ step: "off" });
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (!publicKey) return;
    setState({ step: "working" });
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState({ step: permission === "denied" ? "blocked" : "off" });
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey)
      });
      const json = subscription.toJSON();
      const saved = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint, keys: json.keys, userAgent: navigator.userAgent })
      });
      if (!saved.ok) {
        // Leaving a browser subscription that the server does not know about would mean a phone
        // that looks subscribed and never rings.
        await subscription.unsubscribe().catch(() => undefined);
        setState({ step: "failed", reason: "Cubby could not save this device. Try again." });
        return;
      }
      setState({ step: "on" });
    } catch {
      setState({ step: "failed", reason: "This device could not be registered for notifications." });
    }
  }

  async function turnOff() {
    setState({ step: "working" });
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
      setState({ step: "off" });
    } catch {
      setState({ step: "failed", reason: "This device could not be unregistered." });
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 text-lg font-semibold">This device</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Get a notification on this device when someone posts a moment, or comments on and reacts to yours.
      </p>

      {state.step === "checking" && <p className="text-sm text-muted-foreground">Checking this device…</p>}

      {state.step === "needs-install" && (
        <div className="text-sm text-muted-foreground">
          <p className="mb-2">
            On an iPhone or iPad, notifications work only once Cubby is on the Home Screen.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Tap the Share button in Safari.</li>
            <li>Choose &ldquo;Add to Home Screen&rdquo;.</li>
            <li>Open Cubby from the new icon, then come back to this page.</li>
          </ol>
        </div>
      )}

      {state.step === "unsupported" && <p className="text-sm text-muted-foreground">{state.reason}</p>}

      {state.step === "blocked" && (
        <p className="text-sm text-muted-foreground">
          Notifications are blocked for Cubby in this browser&rsquo;s settings. Allow them there, then reload this page.
        </p>
      )}

      {state.step === "off" && (
        <button
          type="button"
          onClick={turnOn}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Turn on notifications
        </button>
      )}

      {state.step === "on" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">Notifications are on for this device.</p>
          <button
            type="button"
            onClick={turnOff}
            className="inline-flex min-h-11 items-center rounded-lg border border-control bg-card px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Turn off
          </button>
        </div>
      )}

      {state.step === "working" && <p className="text-sm text-muted-foreground">Working…</p>}

      {state.step === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{state.reason}</p>
          <button
            type="button"
            onClick={turnOn}
            className="inline-flex min-h-11 items-center rounded-lg border border-control bg-card px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
