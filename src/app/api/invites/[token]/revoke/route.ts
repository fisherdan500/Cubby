import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  issueInviteRevokeBrowserOperation,
  revokeInvite,
  submitInviteRevokeBrowserOperation
} from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { token: string } }) {
  let operationId: unknown;
  try {
    const text = await request.text();
    let body: Record<string, unknown> | undefined;
    if (text.length > 0) {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("validation_error");
      body = parsed as Record<string, unknown>;
    }
    operationId = body?.operationId;
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const input = { ...body, operationId, inviteId: params.token };
      const issued = await issueInviteRevokeBrowserOperation(input);
      const result = issued.status === "open" ? await submitInviteRevokeBrowserOperation(input) : issued;
      return ok(result);
    }
    return ok(await revokeInvite(params.token));
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
