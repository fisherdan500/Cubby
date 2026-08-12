import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueReactivateBabyBrowserOperation,
  submitReactivateBabyBrowserOperation
} from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const input = { operationId, babyId: params.id };
    const issued = await issueReactivateBabyBrowserOperation(input);
    const result = issued.status === "open" ? await submitReactivateBabyBrowserOperation(input) : issued;
    return ok({ status: result.status, operationId: result.operationId });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok({ status: failure.status, operationId: failure.operationId });
    return handleError(error);
  }
}
