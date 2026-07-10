import { ok, handleError } from "@/server/http";
import { removeMember, updateMemberRole } from "@/server/services/invites";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await updateMemberRole(params.id, await request.json()));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await removeMember(params.id));
  } catch (error) {
    return handleError(error);
  }
}
