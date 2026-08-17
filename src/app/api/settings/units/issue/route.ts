import { handleError, ok } from "@/server/http";
import { issueUnitPreferencesBrowserOperation } from "@/server/services/unit-preferences";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = await issueUnitPreferencesBrowserOperation(await request.json() as { operationId?: unknown });
    const status = result.status === "open" ? 201 : result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
