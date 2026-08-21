import { handleError, ok } from "@/server/http";
import { abandonCurrentHouseholdBrowserOperation, getHouseholdBrowserOperationStatus } from "@/server/services/browser-operation-status";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { operationId: string } }
) {
  try {
    const result = await getHouseholdBrowserOperationStatus(params.operationId);
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
    return ok(await abandonCurrentHouseholdBrowserOperation(params.operationId), { status: 410 });
  } catch (error) {
    return handleError(error);
  }
}
