import { ok, handleError } from "@/server/http";
import { listNotificationPreferences, saveNotificationPreference } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listNotificationPreferences());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    return ok(await saveNotificationPreference(await request.json()), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
