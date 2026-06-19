import { ok, handleError } from "@/server/http";
import { createInvite } from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return ok(await createInvite(await request.json()), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
