import { ok, handleError } from "@/server/http";
import { hookBabies, withApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return ok(await withApiKey(request, "read", (ctx, tx) => hookBabies(ctx, tx)));
  } catch (error) {
    return handleError(error);
  }
}
