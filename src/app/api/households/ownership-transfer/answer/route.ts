import { fail, handleError, ok } from "@/server/http";
import {
  acceptOwnershipTransfer,
  declineOwnershipTransfer
} from "@/server/services/household-ownership-transfer";

export const dynamic = "force-dynamic";

/**
 * The recipient answers a pending transfer.
 *
 * Accept and decline share a route because they are the same decision with two outcomes, and
 * routing them together keeps the recipient-identity check in one place.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body === null) return fail("invalid_json", "Provide a valid JSON request body.");
    const { answer, ...rest } = body;
    if (answer !== "accept" && answer !== "decline") {
      return fail("invalid_request", "Answer the transfer with accept or decline.");
    }
    return ok(answer === "accept"
      ? await acceptOwnershipTransfer(rest)
      : await declineOwnershipTransfer(rest));
  } catch (error) {
    return handleError(error);
  }
}
