import { fail, handleError, ok } from "@/server/http";
import { cancelOwnershipTransfer } from "@/server/services/household-ownership-transfer";

export const dynamic = "force-dynamic";

/**
 * The owner withdraws an offer nobody has answered yet.
 *
 * Separate from the recipient's accept/decline route because the authority is different: this one
 * requires being the owner, that one requires being the named recipient.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return fail("invalid_body", "Send a JSON object.", 400);
    return ok(await cancelOwnershipTransfer(body));
  } catch (error) {
    return handleError(error);
  }
}
