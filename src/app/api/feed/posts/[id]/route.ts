import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import { issueFeedPostDeleteBrowserOperation, submitFeedPostDeleteBrowserOperation } from "@/server/services/feed-posts";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const input = { operationId, postId: params.id };
    const issued = await issueFeedPostDeleteBrowserOperation(input);
    if (new URL(request.url).searchParams.get("issue") === "1") {
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    const result = issued.status === "open" || issued.status === "prepared" ? await submitFeedPostDeleteBrowserOperation(input) : issued;
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
