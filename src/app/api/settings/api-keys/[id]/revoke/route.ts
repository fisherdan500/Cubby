import { ok, handleError } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import { issueApiKeyRevokeBrowserOperation, submitApiKeyRevokeBrowserOperation } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

function operationResponse(result: { status: string; operationId: string; code?: string; outcome?: Record<string, unknown> }) {
  return ok(result, { status: result.status === "pending" || result.status === "prepared" ? 202 : result.status === "expired" ? 410 : 200 });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const text = await request.text();
    if (!text) throw new Error("validation_error");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("validation_error");
    operationId = (parsed as Record<string, unknown>).operationId;
    const input = { operationId, apiKeyId: params.id };
    const issued = await issueApiKeyRevokeBrowserOperation(input);
    if (new URL(request.url).searchParams.get("issue") === "1") return operationResponse(issued);
    const result = issued.status === "open" || issued.status === "prepared" ? await submitApiKeyRevokeBrowserOperation(input) : issued;
    return operationResponse(result);
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return operationResponse(failure);
    return handleError(error);
  }
}
