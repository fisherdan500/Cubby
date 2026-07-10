export function sessionDeviceLabel(userAgent: string | null | undefined) {
  if (!userAgent) return "Unknown browser";

  const browser = userAgent.includes("Edg/")
    ? "Edge"
    : userAgent.includes("Firefox/")
      ? "Firefox"
      : userAgent.includes("Chrome/") || userAgent.includes("CriOS/")
        ? "Chrome"
        : userAgent.includes("Safari/")
          ? "Safari"
          : "Browser";
  const device = /iPhone|iPad/.test(userAgent)
    ? "iPhone or iPad"
    : userAgent.includes("Android")
      ? "Android"
      : userAgent.includes("Windows")
        ? "Windows"
        : userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")
          ? "Mac"
          : userAgent.includes("Linux")
            ? "Linux"
            : null;

  return device ? `${browser} on ${device}` : browser;
}

export function sessionDateLabel(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
