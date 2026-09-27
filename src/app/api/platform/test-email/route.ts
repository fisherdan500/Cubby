import { handleError, ok } from "@/server/http";
import { sendPlatformTestEmail } from "@/server/services/platform-test-email";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await sendPlatformTestEmail();
    return ok(result, result.status === "throttled" ? { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } } : undefined);
  } catch (error) {
    return handleError(error);
  }
}
