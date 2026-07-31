import { ok, handleError } from "@/server/http";
import { stopTimer } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const text = await request.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error("validation_error");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body) || !("clientMutationId" in body)) {
        throw new Error("validation_error");
      }
    }
    return ok(await stopTimer(params.id, body));
  } catch (error) {
    return handleError(error);
  }
}
