import { ok, handleError } from "@/server/http";
import { stopTimer } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await stopTimer(params.id));
  } catch (error) {
    return handleError(error);
  }
}
