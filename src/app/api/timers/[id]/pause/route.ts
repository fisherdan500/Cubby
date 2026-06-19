import { ok, handleError } from "@/server/http";
import { pauseTimer } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await pauseTimer(params.id));
  } catch (error) {
    return handleError(error);
  }
}
