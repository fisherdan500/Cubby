import { ok, handleError } from "@/server/http";
import { pauseTimer } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => undefined);
    return ok(await pauseTimer(params.id, body));
  } catch (error) {
    return handleError(error);
  }
}
