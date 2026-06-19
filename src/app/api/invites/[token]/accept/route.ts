import { ok, handleError } from "@/server/http";
import { acceptInvite } from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { token: string } }) {
  try {
    return ok(await acceptInvite(params.token));
  } catch (error) {
    return handleError(error);
  }
}
