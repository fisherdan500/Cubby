import { ok, handleError } from "@/server/http";
import { assertBabyAllowed, hookReference, withApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { babyId: string } }) {
  try {
    return ok(await withApiKey(request, "read", async (ctx) => {
      assertBabyAllowed(ctx, params.babyId);
      return hookReference();
    }));
  } catch (error) {
    return handleError(error);
  }
}
