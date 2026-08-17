import { ok, handleError } from "@/server/http";
import {
  issueActivityUndoLastBrowserOperation,
  submitActivityUndoLastBrowserOperation,
  undoLastActivity
} from "@/server/services/activities";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let operationId: unknown;
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
    operationId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).operationId : undefined;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueActivityUndoLastBrowserOperation(body);
      const result = issued.status === "open" ? await submitActivityUndoLastBrowserOperation(body) : issued;
      const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
      return ok({ status: result.status, operationId: result.operationId }, { status });
    }
    return ok(await undoLastActivity(body));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok({ status: failure.status, operationId: failure.operationId });
    return handleError(error);
  }
}
