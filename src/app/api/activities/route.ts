import { ok, handleError } from "@/server/http";
import { createActivity, listActivities } from "@/server/services/activities";

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
  try {
    return ok(await createActivity(await request.json()), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
