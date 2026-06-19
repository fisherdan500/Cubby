import { ok, handleError } from "@/server/http";
import { deleteWebhook } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await deleteWebhook(params.id));
  } catch (error) {
    return handleError(error);
  }
}
