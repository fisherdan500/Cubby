import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { listGlobalSecurityHistory, parseGlobalSecurityHistoryLimit } from "@/server/services/global-security-history";

export const dynamic = "force-dynamic";

function parseQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (key !== "limit" && key !== "cursor" || params.getAll(key).length !== 1) throw new Error("security_history_query_invalid");
  }
  const cursor = params.get("cursor");
  if (cursor !== null && cursor.length === 0) throw new Error("security_history_query_invalid");
  return { limit: parseGlobalSecurityHistoryLimit(params.get("limit")), ...(cursor === null ? {} : { cursor }) };
}

function historyError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "security_history_query_invalid") return fail(code, "Check the history request and try again.", 422);
  if (code === "security_history_cursor_invalid") return fail(code, "This history page is no longer available. Reload security history and try again.", 422);
  return handleError(error);
}

export async function GET(request: Request) {
  try {
    const input = parseQuery(request);
    const context = await requireGlobalSecurityContext();
    return ok(await listGlobalSecurityHistory(prisma, context, input));
  } catch (error) {
    return historyError(error);
  }
}
