import { handleError, ok } from "@/server/http";
import { issueCreateBabyBrowserOperation } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = await issueCreateBabyBrowserOperation(await request.json() as Record<string, unknown>);
    const status = result.status === "open" ? 201 : result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
