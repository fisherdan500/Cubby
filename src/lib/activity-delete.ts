type ActivityDeleteResult =
  | { ok: true }
  | { ok: false; error?: { message?: string } }
  | null;

export function activityDeleteError(responseOk: boolean, result: ActivityDeleteResult) {
  if (responseOk && result?.ok) return undefined;
  if (!result || result.ok || !("error" in result)) return "Could not delete this activity.";
  return result.error?.message || "Could not delete this activity.";
}
