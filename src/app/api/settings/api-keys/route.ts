import { fail, ok, handleError } from "@/server/http";
import { listApiKeys } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listApiKeys());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(_request: Request) {
  return fail("api_key_issuance_unavailable", "New API-key issuance is unavailable until credential rotation is ready.", 409);
}
