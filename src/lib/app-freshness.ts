export const FRESHNESS_REQUESTED_EVENT = "cubby:freshness-requested";
export type FreshnessRequest = { generation: number };

// getRandomValues also works on household LAN HTTP origins where randomUUID is unavailable.
export function createFreshnessRequestToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

declare global {
  interface WindowEventMap {
    "cubby:freshness-requested": CustomEvent<FreshnessRequest>;
  }
}
