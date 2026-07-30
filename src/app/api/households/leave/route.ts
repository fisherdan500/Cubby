import { fail, handleError, ok } from "@/server/http";
import { leaveHousehold } from "@/server/services/household-leave";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (body === null) return fail("invalid_json", "Provide a valid JSON request body.");
    return ok(await leaveHousehold(body));
  } catch (error) {
    return handleError(error);
  }
}
