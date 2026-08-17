import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueMemberBrowserOperation,
  restoreMember,
  submitMemberBrowserOperation
} from "@/server/services/invites";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let operationId: unknown;
  try {
    const { id } = await params;
    const raw = await request.json().catch(() => ({})) as Record<string, unknown>;
    operationId = raw.operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const input = { ...raw, memberId: id };
      const issued = await issueMemberBrowserOperation("restore", input);
      const result = issued.status === "open" ? await submitMemberBrowserOperation("restore", input) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    return ok(await restoreMember(id));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    return failure ? ok(failure) : handleError(error);
  }
}
