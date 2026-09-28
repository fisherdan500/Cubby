const retryableCodes = new Set(["55P03", "40001", "40P01", "P2034"]);
const backoffMilliseconds = [25, 75] as const;

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if (typeof error.code === "string" && retryableCodes.has(error.code)) return true;
  if (error.code !== "P2010" || !("meta" in error) || typeof error.meta !== "object" || error.meta === null) return false;
  return "code" in error.meta && typeof error.meta.code === "string" && retryableCodes.has(error.meta.code);
}

/** The caller must open a fresh Serializable transaction on each invocation.
 * Keep hashing and all nontransactional effects outside this callback. */
export async function runAssistedSerializableTransaction<T>(
  action: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); }
    catch (error) {
      const delay = backoffMilliseconds[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      await sleep(delay);
    }
  }
}
