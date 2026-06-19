import { ok, handleError } from "@/server/http";
import { hookBabies, requireApiKey } from "@/server/services/hooks";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, "read");
    return ok(await hookBabies(ctx));
  } catch (error) {
    return handleError(error);
  }
}
