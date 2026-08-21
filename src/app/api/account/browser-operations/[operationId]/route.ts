import { handleError, ok } from "@/server/http";
import { getAccountBrowserOperationStatus } from "@/server/services/account-browser-operation-status";
import { abandonAccountAppearanceBrowserOperation } from "@/server/services/account-appearance";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { operationId: string } }
) {
  try {
    const result = await getAccountBrowserOperationStatus(params.operationId);
    const status = result.status === "pending" || result.status === "prepared" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { operationId: string } }
) {
  try {
    return ok(await abandonAccountAppearanceBrowserOperation({ operationId: params.operationId }), { status: 410 });
  } catch (error) {
    return handleError(error);
  }
}
