import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueMemberBrowserOperation,
  submitMemberBrowserOperation,
  suspendMember
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
    const input = { ...raw, memberId: id };
    if (new URL(request.url).searchParams.get("issue") === "1") {
      const issued = await issueMemberBrowserOperation("suspend", input);
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueMemberBrowserOperation("suspend", input);
      const result = issued.status === "open" || issued.status === "prepared" ? await submitMemberBrowserOperation("suspend", input) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    return ok(await suspendMember(id));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    return failure ? ok(failure) : handleError(error);
  }
}
