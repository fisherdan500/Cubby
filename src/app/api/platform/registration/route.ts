import { handleError, ok } from "@/server/http";
import {
  allocatePlatformRegistrationOperation,
  completePlatformRegistrationOperation,
  getPlatformRegistrationOperationStatus,
  getPlatformRegistrationSettings
} from "@/server/services/platform-authority";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const operationId = new URL(request.url).searchParams.get("operationId");
    if (operationId !== null) return ok(await getPlatformRegistrationOperationStatus({ operationId }));
    return ok(await getPlatformRegistrationSettings());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input: unknown = await request.json();
    return ok(await allocatePlatformRegistrationOperation(input));
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const input: unknown = await request.json();
    return ok(await completePlatformRegistrationOperation(input));
  } catch (error) {
    return handleError(error);
  }
}
