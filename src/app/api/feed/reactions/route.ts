import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import { issueFeedReactionSetBrowserOperation, submitFeedReactionSetBrowserOperation } from "@/server/services/feed-interactions";

export const dynamic = "force-dynamic";

/** Sets one reaction on or off for the signed-in member. */
export async function PUT(request: Request) {
  let operationId: unknown;
  try {
    const raw = await request.json() as Record<string, unknown>;
    operationId = raw.operationId;
    const issued = await issueFeedReactionSetBrowserOperation(raw);
    if (new URL(request.url).searchParams.get("issue") === "1") {
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    const result = issued.status === "open" || issued.status === "prepared" ? await submitFeedReactionSetBrowserOperation(raw) : issued;
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
