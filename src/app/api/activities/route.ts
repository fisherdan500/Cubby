import { ok, handleError } from "@/server/http";
import {
  createActivity,
  issueActivityCreateBrowserOperation,
  listActivities,
  submitActivityCreateBrowserOperation
} from "@/server/services/activities";
import { browserOperationFailureResult } from "@/server/services/browser-operations";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return ok(
      await listActivities({
        babyId: url.searchParams.get("babyId") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        search: url.searchParams.get("search") ?? undefined
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  let operationId: unknown;
  try {
    const raw = await request.json();
    operationId = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).operationId : undefined;
    if (new URL(request.url).searchParams.get("issue") === "1") {
      const issued = await issueActivityCreateBrowserOperation(raw);
      const status = issued.status === "pending" || issued.status === "prepared" ? 202 : issued.status === "expired" ? 410 : 200;
      return ok(issued, { status });
    }
    if (typeof operationId === "string" && operationId.startsWith("bmo_")) {
      const issued = await issueActivityCreateBrowserOperation(raw);
      const result = issued.status === "open" || issued.status === "prepared" ? await submitActivityCreateBrowserOperation(raw) : issued;
      const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
      return ok(result, { status });
    }
    return ok(await createActivity(raw), { status: 201 });
  } catch (error) {
    const failure = browserOperationFailureResult(operationId, error);
    if (failure) return ok(failure);
    return handleError(error);
  }
}
