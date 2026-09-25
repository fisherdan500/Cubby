import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueFeedCommentDeleteBrowserOperation,
  issueFeedCommentUpdateBrowserOperation,
  submitFeedCommentDeleteBrowserOperation,
  submitFeedCommentUpdateBrowserOperation
} from "@/server/services/feed-interactions";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const input = { operationId, commentId: params.id, body: raw.body };
    const issued = await issueFeedCommentUpdateBrowserOperation(input);
    if (new URL(request.url).searchParams.get("issue") === "1") {
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    const result = issued.status === "open" || issued.status === "prepared" ? await submitFeedCommentUpdateBrowserOperation(input) : issued;
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const input = { operationId, commentId: params.id };
    const issued = await issueFeedCommentDeleteBrowserOperation(input);
    if (new URL(request.url).searchParams.get("issue") === "1") {
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    const result = issued.status === "open" || issued.status === "prepared" ? await submitFeedCommentDeleteBrowserOperation(input) : issued;
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
