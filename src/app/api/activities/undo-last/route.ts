import { ok, handleError } from "@/server/http";
import { undoLastActivity } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const text = await request.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error("validation_error");
      }
    }
    return ok(await undoLastActivity(body));
  } catch (error) {
    return handleError(error);
  }
}
