import { ok, handleError } from "@/server/http";
import { revokeApiKey } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await revokeApiKey(params.id));
  } catch (error) {
    return handleError(error);
  }
}
