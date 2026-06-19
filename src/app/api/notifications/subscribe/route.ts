import { ok, handleError } from "@/server/http";
import { savePushSubscription } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return ok(await savePushSubscription(await request.json()), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
