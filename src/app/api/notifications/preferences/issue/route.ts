import { ok, handleError } from "@/server/http";
import { issueNotificationPreferenceBrowserOperation } from "@/server/services/notification-preferences";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = await issueNotificationPreferenceBrowserOperation(await request.json() as { operationId?: unknown });
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    return handleError(error);
  }
}
