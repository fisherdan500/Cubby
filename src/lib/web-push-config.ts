import { z } from "zod";

/**
 * Web push configuration.
 *
 * Push is OFF unless a VAPID key pair and contact address are present, so an install that has
 * never generated keys behaves exactly as it does today rather than failing at startup. The
 * private key is a secret: it is read from the environment, never logged, and never returned by
 * any route - only the public key is sent to a browser, which is what it is for.
 *
 * CUBBY_PUBLIC_URL exists because a notification's click target has to be absolute and reachable
 * from a phone. BETTER_AUTH_URL may legitimately be an internal address when a reverse proxy
 * terminates TLS in front of Cubby, and a notification opening that address would fail. It falls
 * back to BETTER_AUTH_URL so an install that serves itself directly needs no new setting.
 */

/** Uncompressed P-256 point, base64url: 65 bytes -> 87 characters. */
const VAPID_PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;
/** 32-byte scalar, base64url: 43 characters. */
const VAPID_PRIVATE_KEY = /^[A-Za-z0-9_-]{43}$/;

const schema = z.object({
  publicKey: z.string().regex(VAPID_PUBLIC_KEY, "WEB_PUSH_VAPID_PUBLIC_KEY must be a base64url P-256 public key").optional(),
  privateKey: z.string().regex(VAPID_PRIVATE_KEY, "WEB_PUSH_VAPID_PRIVATE_KEY must be a base64url 32-byte key").optional(),
  // RFC 8292 requires a contact the push service can reach about a misbehaving sender.
  subject: z.string().regex(/^(mailto:.+@.+|https:\/\/.+)$/, "WEB_PUSH_CONTACT must be a mailto: address or https: url").optional(),
  publicUrl: z.string().url().optional()
});

export type WebPushConfig =
  | { enabled: false; reason: string; publicUrl: string }
  | { enabled: true; publicKey: string; privateKey: string; subject: string; publicUrl: string };

export function readWebPushConfig(raw: {
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  WEB_PUSH_CONTACT?: string;
  CUBBY_PUBLIC_URL?: string;
  BETTER_AUTH_URL?: string;
}): WebPushConfig {
  const trimmed = {
    publicKey: raw.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || undefined,
    privateKey: raw.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() || undefined,
    subject: raw.WEB_PUSH_CONTACT?.trim() || undefined,
    publicUrl: raw.CUBBY_PUBLIC_URL?.trim() || raw.BETTER_AUTH_URL?.trim() || undefined
  };
  const parsed = schema.parse(trimmed);
  const publicUrl = (parsed.publicUrl ?? "http://localhost:3000").replace(/\/+$/, "");

  const missing = [
    parsed.publicKey ? null : "WEB_PUSH_VAPID_PUBLIC_KEY",
    parsed.privateKey ? null : "WEB_PUSH_VAPID_PRIVATE_KEY",
    parsed.subject ? null : "WEB_PUSH_CONTACT"
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    return { enabled: false, reason: `not configured: ${missing.join(", ")}`, publicUrl };
  }

  // A phone will not register a service worker, and so cannot receive push, outside a secure
  // context. Refusing here turns an invisible "notifications never arrive" into a stated reason.
  if (!isSecurePublicUrl(publicUrl)) {
    return {
      enabled: false,
      reason: "the public address must be https (or localhost); browsers refuse push on a plain http address",
      publicUrl
    };
  }

  return {
    enabled: true,
    publicKey: parsed.publicKey!,
    privateKey: parsed.privateKey!,
    subject: parsed.subject!,
    publicUrl
  };
}

export function isSecurePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    // Browsers treat loopback as a secure context, which keeps local development working.
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** An absolute url for a notification click, built from the public address rather than a request. */
export function publicAppUrl(publicUrl: string, path: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
