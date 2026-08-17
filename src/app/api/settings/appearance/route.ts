import { ok, handleError } from "@/server/http";
import {
  getHouseholdAppearance,
  submitHouseholdAppearanceBrowserOperation
} from "@/server/services/appearance";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getHouseholdAppearance());
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const result = await submitHouseholdAppearanceBrowserOperation(await request.json());
    return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
  } catch (error) {
    return handleError(error);
  }
}
