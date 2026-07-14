import { ok, handleError } from "@/server/http";
import {
  getUnitPreferenceSettings,
  updateUnitPreferences
} from "@/server/services/unit-preferences";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getUnitPreferenceSettings());
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return ok(await updateUnitPreferences(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
