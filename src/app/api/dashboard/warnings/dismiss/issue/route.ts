import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import { issueDashboardWarningBrowserOperation } from "@/server/services/dashboard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const result = await issueDashboardWarningBrowserOperation(raw);
    return ok(result, { status: result.status === "pending" || result.status === "prepared" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
