import { handleError, ok } from "@/server/http";
import { sendPlatformTestEmail } from "@/server/services/platform-test-email";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return ok(await sendPlatformTestEmail());
  } catch (error) {
    return handleError(error);
  }
}
