import { fail, ok, handleError } from "@/server/http";
import { createInvite, issueInviteCreateBrowserOperation, submitInviteCreateBrowserOperation } from "@/server/services/invites";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let operationId: unknown;
  try {
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", "Provide a valid JSON request body.");
    operationId = (body as Record<string, unknown>).operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueInviteCreateBrowserOperation(body);
      const result = issued.status === "open" ? await submitInviteCreateBrowserOperation(body) : issued;
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : result.status === "open" ? 201 : 200 });
    }
    return ok(await createInvite(body), { status: 201 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
