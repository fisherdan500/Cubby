import { handleError, ok } from "@/server/http";
import { getAccountBrowserOperationStatus } from "@/server/services/account-browser-operation-status";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { operationId: string } }
) {
  try {
    const result = await getAccountBrowserOperationStatus(params.operationId);
    const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
