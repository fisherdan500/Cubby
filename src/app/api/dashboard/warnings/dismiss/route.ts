import { ok, handleError } from "@/server/http";
import { dismissDashboardWarning } from "@/server/services/dashboard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return ok(await dismissDashboardWarning(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
