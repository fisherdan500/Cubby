import { handleError, ok } from "@/server/http";
import { issueAccountAppearanceBrowserOperation } from "@/server/services/account-appearance";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await request.json() as { operationId?: unknown };
    const result = await issueAccountAppearanceBrowserOperation(input);
    const status = result.status === "open" ? 201 : result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
