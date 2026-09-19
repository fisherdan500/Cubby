import { handleError, ok } from "@/server/http";
import { claimPlatformSetup } from "@/server/services/platform-setup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input: unknown = await request.json();
    return ok(await claimPlatformSetup(input));
  } catch (error) {
    return handleError(error);
  }
}
