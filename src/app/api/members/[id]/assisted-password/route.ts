import { handleError, ok } from "@/server/http";
import { browserOperationFailureResult } from "@/server/services/browser-operations";
import {
  abandonAssistedMemberPasswordReset,
  getAssistedMemberPasswordResetStatus,
  issueAssistedMemberPasswordReset,
  submitAssistedMemberPasswordReset
} from "@/server/services/admin-assisted-accounts-service";

export const dynamic = "force-dynamic";

function assistedResponseStatus(result: { status: string }) {
  if (result.status === "pending") return 202;
  if (result.status === "expired") return 410;
  return 200;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let operationId: unknown;
  try {
    const { id } = await params;
    const raw = await request.json().catch(() => ({})) as Record<string, unknown>;
    operationId = raw.operationId;
    const query = new URL(request.url).searchParams;
    const result = query.get("issue") === "1"
      ? await issueAssistedMemberPasswordReset(id, raw)
      : query.get("status") === "1"
        ? await getAssistedMemberPasswordResetStatus(raw)
        : query.get("abandon") === "1"
          ? await abandonAssistedMemberPasswordReset(raw)
          : await submitAssistedMemberPasswordReset(id, raw);
    return ok(result, { status: assistedResponseStatus(result as { status: string }) });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    return failure ? ok(failure, { status: assistedResponseStatus(failure) }) : handleError(error);
  }
}
