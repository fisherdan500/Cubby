import { dateKeyInTimeZone } from "@/lib/timezone";

export function activityBackLabel(source: string) {
  const pathname = source.split(/[?#]/, 1)[0];
  if (pathname === "/app/history") return "Back to Full Log";
  if (pathname === "/app/calendar") return "Back to Calendar";
  return "Back to Dashboard";
}

export function safeActivityReturnTo(value: unknown) {
  const safeValue = safeInternalAppHref(value);
  if (!safeValue) return undefined;
  const decodedPathname = decodeURIComponent(safeValue.split(/[?#]/, 1)[0]);
  return decodedPathname.startsWith("/app/activities/") ? undefined : safeValue;
}

export function safeInternalAppHref(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return undefined;
  const rawPathname = value.split(/[?#]/, 1)[0];
  if (/%(?![0-9a-f]{2})|%(?:2f|5c)/i.test(rawPathname)) return undefined;

  const url = new URL(value, "https://cubby.invalid");
  if (url.origin !== "https://cubby.invalid") return undefined;
  const pathname = url.pathname.replace(/\/{2,}/g, "/");
  try {
    decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (pathname !== "/app" && !pathname.startsWith("/app/")) return undefined;
  const search = url.search ? `?${url.searchParams.toString()}` : "";
  return `${pathname}${search}${url.hash}`;
}

export function activityDetailHref(activityId: string, returnTo?: string) {
  return activityRouteHref(`/app/activities/${encodeURIComponent(activityId)}`, returnTo);
}

export function activityEditHref(activityId: string, returnTo?: string) {
  return activityRouteHref(`/app/activities/${encodeURIComponent(activityId)}/edit`, returnTo);
}

export function activityFallbackHref({
  babyId,
  occurredAt,
  timeZone
}: {
  babyId: string;
  occurredAt: Date;
  timeZone: string;
}) {
  return `/app?${new URLSearchParams({ babyId, date: dateKeyInTimeZone(occurredAt, timeZone) }).toString()}`;
}

function activityRouteHref(path: string, returnTo?: string) {
  const safeReturnTo = safeActivityReturnTo(returnTo);
  return safeReturnTo ? `${path}?${new URLSearchParams({ returnTo: safeReturnTo }).toString()}` : path;
}
