import { fail, handleError, ok } from "@/server/http";
import {
  getOwnershipTransferRecipients,
  initiateOwnershipTransfer
} from "@/server/services/household-ownership-transfer";

export const dynamic = "force-dynamic";

/** Who this household could be handed to. Owner-only; the service enforces that. */
export async function GET(request: Request) {
  try {
    const householdId = new URL(request.url).searchParams.get("householdId");
    if (!householdId) return fail("invalid_request", "Name the household to list transfer recipients for.");
    return ok(await getOwnershipTransferRecipients(householdId));
  } catch (error) {
    return handleError(error);
  }
}

/** The owner names a successor. This creates a PENDING transfer and moves no authority. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (body === null) return fail("invalid_json", "Provide a valid JSON request body.");
    return ok(await initiateOwnershipTransfer(body));
  } catch (error) {
    return handleError(error);
  }
}
