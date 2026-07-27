import { ok, handleError } from "@/server/http";
import { hookBabyStatus, withApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { babyId: string } }) {
  try {
    return ok(await withApiKey(request, "read", (ctx, tx) => hookBabyStatus(ctx, params.babyId, tx)));
  } catch (error) {
    return handleError(error);
  }
}
