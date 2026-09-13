export type InvitationFragmentConsumption = {
  rawToken: string;
  replacementUrl: "/invite";
};

/**
 * This is intentionally browser-edge only. Callers must submit the returned
 * token once, then use history.replaceState with replacementUrl before any
 * render, analytics, or navigation work can observe it.
 */
export function consumeInvitationFragment(
  value: string
): InvitationFragmentConsumption | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.pathname !== "/invite" || url.search || !url.hash.startsWith("#c=")) {
    return null;
  }

  const encodedToken = url.hash.slice(3);
  if (!encodedToken || encodedToken.includes("&") || encodedToken.includes("=")) {
    return null;
  }

  try {
    const rawToken = decodeURIComponent(encodedToken);
    return rawToken ? { rawToken, replacementUrl: "/invite" } : null;
  } catch {
    return null;
  }
}
