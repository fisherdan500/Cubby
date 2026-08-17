import { ok, handleError } from "@/server/http";
import {
  getOwnNotificationPreference,
  submitNotificationPreferenceBrowserOperation
} from "@/server/services/notification-preferences";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getOwnNotificationPreference());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const result = await submitNotificationPreferenceBrowserOperation(await request.json() as Record<string, unknown>);
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    return handleError(error);
  }
}
