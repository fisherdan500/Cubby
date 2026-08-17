import { fail, handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueInviteRevokeAllBrowserOperation,
  revokeAllPendingInvites,
  submitInviteRevokeAllBrowserOperation
} from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let operationId: unknown;
  try {
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", "Provide a valid JSON request body.");
    operationId = (body as Record<string, unknown>).operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueInviteRevokeAllBrowserOperation(body);
      const result = issued.status === "open" ? await submitInviteRevokeAllBrowserOperation(body) : issued;
      return ok(result);
    }
    return ok(await revokeAllPendingInvites(body));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
