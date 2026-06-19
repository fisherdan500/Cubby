import { ok, handleError } from "@/server/http";
import { hookActivities, hookCreateActivity, requireApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { babyId: string } }) {
  try {
    const ctx = await requireApiKey(request, "read");
    return ok(await hookActivities(ctx, params.babyId));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, { params }: { params: { babyId: string } }) {
  try {
    const ctx = await requireApiKey(request, "write");
    return ok(await hookCreateActivity(ctx, params.babyId, await request.json()), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
