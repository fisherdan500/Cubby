import { activityUpdateSchema } from "@/lib/validation/activity";
import { ok, handleError } from "@/server/http";
import { deleteActivity, updateActivity } from "@/server/services/activities";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const text = await request.text();
    if (text.length === 0) throw new Error("validation_error");
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error("validation_error");
    }
    activityUpdateSchema.parse({ ...(body as object), id: params.id });
    return ok(await updateActivity(params.id, body));
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
