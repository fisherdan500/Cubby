import { handleError, ok } from "@/server/http";
import { issueHouseholdAppearanceBrowserOperation } from "@/server/services/appearance";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = await issueHouseholdAppearanceBrowserOperation(await request.json() as { operationId?: unknown });
    const status = result.status === "open" ? 201 : result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
