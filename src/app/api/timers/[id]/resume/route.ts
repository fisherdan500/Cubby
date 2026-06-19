import { ok, handleError } from "@/server/http";
import { resumeTimer } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await resumeTimer(params.id));
  } catch (error) {
    return handleError(error);
  }
}
