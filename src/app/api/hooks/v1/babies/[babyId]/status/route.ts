import { ok, handleError } from "@/server/http";
import { hookBabyStatus, requireApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { babyId: string } }) {
  try {
    const ctx = await requireApiKey(request, "read");
    return ok(await hookBabyStatus(ctx, params.babyId));
  } catch (error) {
    return handleError(error);
  }
}
