import { ok, handleError } from "@/server/http";
import { issueActivityTimerBrowserOperation, stopTimer, submitActivityTimerBrowserOperation } from "@/server/services/activities";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const text = await request.text();
    let body: unknown;
    if (text.length > 0) {
      try { body = JSON.parse(text) as unknown; } catch { throw new Error("validation_error"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("validation_error");
    }
    operationId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).operationId : undefined;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const input = { ...(body as Record<string, unknown>), activityId: params.id };
      const issued = await issueActivityTimerBrowserOperation("stop", input);
      const result = issued.status === "open" ? await submitActivityTimerBrowserOperation("stop", input) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    if (body !== undefined && !("clientMutationId" in (body as Record<string, unknown>))) throw new Error("validation_error");
    return ok(await stopTimer(params.id, body));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
