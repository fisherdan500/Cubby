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
    const result = issued.status === "open" || issued.status === "prepared"
      ? await dismissDashboardWarningBrowserOperation(raw)
      : issued;
    if (result.status === "completed") return ok(result);
    return ok(
      result,
      { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 }
    );
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
