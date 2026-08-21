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
    if (new URL(request.url).searchParams.get("issue") === "1") {
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    const result = issued.status === "open" || issued.status === "prepared" ? await submitReactivateBabyBrowserOperation(input) : issued;
    return ok(result,
      { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 }
    );
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
