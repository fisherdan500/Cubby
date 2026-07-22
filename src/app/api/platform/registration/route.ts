import { handleError, ok } from "@/server/http";
import {
  getPlatformRegistrationSettings,
  updatePlatformRegistrationSettings
} from "@/server/services/platform-authority";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getPlatformRegistrationSettings());
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const input: unknown = await request.json();
    return ok(await updatePlatformRegistrationSettings(input));
  } catch (error) {
    return handleError(error);
  }
}
