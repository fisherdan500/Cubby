import { trustedOrigins } from "@/lib/env";
import { handleError, ok } from "@/server/http";
import { createPlatformOwnerAccount } from "@/server/services/platform-setup";

export const dynamic = "force-dynamic";

/**
 * The one request that creates an account without a session or an invitation, so it is held to a
 * same-site JSON request before anything is read; the setup code and the empty-install check decide
 * the rest in the database.
 */
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || (origin !== new URL(request.url).origin && !trustedOrigins().includes(origin))) {
      throw new Error("forbidden");
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("validation_error");
    }
    const input: unknown = await request.json();
    return ok(await createPlatformOwnerAccount(input));
  } catch (error) {
    return handleError(error);
  }
}
