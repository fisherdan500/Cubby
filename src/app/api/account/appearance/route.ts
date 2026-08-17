import { handleError, ok } from "@/server/http";
import {
  getAccountAppearance,
  submitAccountAppearanceBrowserOperation
} from "@/server/services/account-appearance";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getAccountAppearance());
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = await request.json() as { operationId?: unknown; appearanceMode?: unknown };
    const result = await submitAccountAppearanceBrowserOperation(input);
    const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
