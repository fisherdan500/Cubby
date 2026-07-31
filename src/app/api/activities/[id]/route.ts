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

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const text = await request.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error("validation_error");
      }
    }
    return ok(await deleteActivity(params.id, body));
  } catch (error) {
    return handleError(error);
  }
}
