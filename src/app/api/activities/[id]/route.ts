import { activityUpdateSchema } from "@/lib/validation/activity";
import { ok, handleError } from "@/server/http";
import {
  deleteActivity,
  issueActivityDeleteBrowserOperation,
  issueActivityUpdateBrowserOperation,
  submitActivityDeleteBrowserOperation,
  submitActivityUpdateBrowserOperation,
  updateActivity
} from "@/server/services/activities";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

function browserOperationResponse(result: { status: string; operationId: string }) {
  const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
  return ok({ status: result.status, operationId: result.operationId }, { status });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const text = await request.text();
    if (text.length === 0) throw new Error("validation_error");
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error("validation_error");
    }
    const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
    operationId = record?.operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const input = { ...record, activityId: params.id };
      const issued = await issueActivityUpdateBrowserOperation(input);
      const result = issued.status === "open" ? await submitActivityUpdateBrowserOperation(input) : issued;
      return browserOperationResponse(result);
    }
    activityUpdateSchema.parse({ ...(body as object), id: params.id });
    return ok(await updateActivity(params.id, body));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return browserOperationResponse(failure);
    return handleError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
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
    const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
    operationId = record?.operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const input = { ...record, activityId: params.id };
      const issued = await issueActivityDeleteBrowserOperation(input);
      const result = issued.status === "open" ? await submitActivityDeleteBrowserOperation(input) : issued;
      return browserOperationResponse(result);
    }
    return ok(await deleteActivity(params.id, body));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return browserOperationResponse(failure);
    return handleError(error);
  }
}
