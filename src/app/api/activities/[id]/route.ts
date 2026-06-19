import { ok, handleError } from "@/server/http";
import { deleteActivity, updateActivity } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await updateActivity(params.id, await request.json()));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await deleteActivity(params.id));
  } catch (error) {
    return handleError(error);
  }
}
