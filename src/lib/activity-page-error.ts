export function activityUnavailableOrThrow(error: unknown): null {
  if (error instanceof Error && (error.message === "not_found" || error.message === "forbidden")) return null;
  throw error;
}
