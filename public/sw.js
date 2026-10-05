const SHELL_CACHE = "cubby-shell-v2";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/brand/cubby-mark.svg",
  "/icons/favicon-32.png",
  "/icons/icon-192.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("cubby-shell-") && key !== SHELL_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

/**
 * A notification about something that happened in Moments.
 *
 * The payload carries no household content - a title, a line naming who did what, and where to
 * open - because a notification is shown on a locked screen to whoever is holding the phone.
 *
 * iOS requires a visible notification for every push it delivers: a push that resolves without
 * calling showNotification counts against the app, and the system eventually stops waking it. So a
 * payload that is missing or unreadable still shows a plain fallback rather than returning quietly.
 */
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const title = (payload && typeof payload.title === "string" && payload.title) || "Cubby";
  const body = (payload && typeof payload.body === "string" && payload.body) || "Something new in Moments";
  const url = (payload && typeof payload.url === "string" && payload.url) || "/app/moments";
  const tag = (payload && typeof payload.tag === "string" && payload.tag) || "cubby-moment";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // Replace rather than stack: three comments on one post is one notification, not three.
      renotify: false,
      icon: "/icons/icon-192.png",
      badge: "/icons/favicon-32.png",
      data: { url }
    })
  );
});

/**
 * Opening a notification. An already-open Cubby window is focused and moved to the right place
 * rather than a second one being opened, so tapping a notification never leaves a caregiver with a
 * pile of duplicate tabs.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/app/moments";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        // Same origin only: the target is absolute, and a window from anywhere else is not ours.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        if ("navigate" in client) return client.navigate(target).then((navigated) => (navigated ? navigated.focus() : null));
        if ("focus" in client) return client.focus();
      }
      try {
        if (new URL(target, self.location.origin).origin !== self.location.origin) return null;
      } catch {
        return null;
      }
      return self.clients.openWindow(target);
    })
  );
});

/** Convert the configured base64url VAPID public key into the bytes expected by PushManager. */
function decodeApplicationServerKey(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

/**
 * A browser can replace a subscription on its own, without the member doing anything. Registering
 * the replacement here keeps a phone receiving notifications instead of going silently quiet until
 * someone notices and toggles the setting off and on again.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let applicationServerKey =
        (event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey) ||
        null;
      if (!applicationServerKey) {
        const response = await fetch("/api/notifications/vapid-key", {
          cache: "no-store",
          credentials: "include"
        });
        const body = await response.json();
        const config = body && body.data;
        if (!response.ok || !config || !config.enabled || typeof config.publicKey !== "string" || !config.publicKey) return;
        applicationServerKey = decodeApplicationServerKey(config.publicKey);
      }
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
      const json = subscription.toJSON();
      const saved = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ endpoint: subscription.endpoint, keys: json.keys })
      }).catch(() => null);
      if (!saved || !saved.ok) await subscription.unsubscribe().catch(() => undefined);
    })()
  );
});
