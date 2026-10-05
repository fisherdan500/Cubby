import { ok, handleError } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { webPushConfig } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The VAPID public key a browser needs to subscribe, plus whether push is configured at all.
 *
 * Only the PUBLIC key is ever sent: it exists to be handed to a browser, and the private key that
 * signs notifications never leaves the server. When push is not configured the reason is returned
 * so the settings page can say why rather than offering a button that cannot work.
 *
 * Behind a sign-in because an unauthenticated caller has no business enumerating how this install
 * is set up.
 */
export async function GET() {
  try {
    await requireUser();
    if (!webPushConfig.enabled) {
      return ok({ enabled: false as const, reason: webPushConfig.reason, publicKey: null });
    }
    return ok({ enabled: true as const, reason: null, publicKey: webPushConfig.publicKey });
  } catch (error) {
    return handleError(error);
  }
}
