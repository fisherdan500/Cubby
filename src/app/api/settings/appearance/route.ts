import { ok, handleError } from "@/server/http";
import { getHouseholdAppearance, updateHouseholdAppearance } from "@/server/services/appearance";

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
    return ok(await updateHouseholdAppearance(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
