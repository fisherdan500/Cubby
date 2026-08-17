import { ok, handleError } from "@/server/http";
import {
  dismissDashboardWarning,
  dismissDashboardWarningBrowserOperation,
  issueDashboardWarningBrowserOperation
} from "@/server/services/dashboard";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    if (!operationId) {
      await dismissDashboardWarning(raw);
      return ok({ status: "completed" });
    }
    const issued = await issueDashboardWarningBrowserOperation(raw);
    const result = issued.status === "open"
      ? await dismissDashboardWarningBrowserOperation(raw)
      : issued;
    if (result.status === "completed") return ok({ status: "completed", operationId: result.operationId });
    return ok({ status: result.status, operationId: result.operationId });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok({ status: failure.status, operationId: failure.operationId });
    return handleError(error);
  }
}
