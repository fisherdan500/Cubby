import { ok, handleError } from "@/server/http";
import { assertBabyAllowed, hookReference, requireApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { babyId: string } }) {
  try {
    const ctx = await requireApiKey(request, "read");
    assertBabyAllowed(ctx, params.babyId);
    return ok(hookReference());
  } catch (error) {
    return handleError(error);
  }
}
