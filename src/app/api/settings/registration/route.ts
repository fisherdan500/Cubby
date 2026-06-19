import { ok, handleError } from "@/server/http";
import { getHouseholdSettings, updateRegistrationSettings } from "@/server/services/registration";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getHouseholdSettings());
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return ok(await updateRegistrationSettings(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
