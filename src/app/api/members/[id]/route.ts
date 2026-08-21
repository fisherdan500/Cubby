import { ok, handleError } from "@/server/http";
import { issueMemberBrowserOperation, removeMember, submitMemberBrowserOperation, updateMemberRole } from "@/server/services/invites";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";
type Params = { params: { id: string } | Promise<{ id: string }> };
async function memberId(params: Params["params"]) { return (await params).id; }

export async function PATCH(request: Request, { params }: Params) {
  let operationId: unknown;
  try {
    const id = await memberId(params);
    const body = await request.json() as Record<string, unknown>;
    operationId = body.operationId;
    const input = { ...body, memberId: id };
    if (new URL(request.url).searchParams.get("issue") === "1") {
      const issued = await issueMemberBrowserOperation("role.update", input);
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueMemberBrowserOperation("role.update", input);
      const result = issued.status === "open" || issued.status === "prepared" ? await submitMemberBrowserOperation("role.update", input) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    return ok(await updateMemberRole(id, body));
  } catch (error) { const failure = browserOperationFailureResult(operationId, error); return failure ? ok(failure) : handleError(error); }
}

export async function DELETE(request: Request, { params }: Params) {
  let operationId: unknown;
  try {
    const id = await memberId(params);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    operationId = body.operationId;
    const input = { ...body, memberId: id };
    if (new URL(request.url).searchParams.get("issue") === "1") {
      const issued = await issueMemberBrowserOperation("remove", input);
      return ok(issued, { status: issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200 });
    }
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueMemberBrowserOperation("remove", input);
      const result = issued.status === "open" || issued.status === "prepared" ? await submitMemberBrowserOperation("remove", input) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    return ok(await removeMember(id));
  } catch (error) { const failure = browserOperationFailureResult(operationId, error); return failure ? ok(failure) : handleError(error); }
}
