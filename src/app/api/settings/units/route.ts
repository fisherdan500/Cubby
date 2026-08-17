import { ok, handleError } from "@/server/http";
import {
  getUnitPreferenceSettings,
  submitUnitPreferencesBrowserOperation
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
    const result = await submitUnitPreferencesBrowserOperation(await request.json() as Record<string, unknown>);
    const status = result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200;
    return ok(result, { status });
  } catch (error) {
    return handleError(error);
  }
}
