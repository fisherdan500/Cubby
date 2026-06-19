import { ok, handleError } from "@/server/http";
import { undoLastActivity } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return ok(await undoLastActivity());
  } catch (error) {
    return handleError(error);
  }
}
