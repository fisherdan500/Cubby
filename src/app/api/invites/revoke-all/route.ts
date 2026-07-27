import { fail, handleError, ok } from "@/server/http";
import { revokeAllPendingInvites } from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (body === null) return fail("invalid_json", "Provide a valid JSON request body.");
    return ok(await revokeAllPendingInvites(body));
  } catch (error) {
    return handleError(error);
  }
}
