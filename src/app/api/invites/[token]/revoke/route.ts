import { ok, handleError } from "@/server/http";
import { revokeInvite } from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { token: string } }) {
  try {
    return ok(await revokeInvite(params.token));
  } catch (error) {
    return handleError(error);
  }
}
