import { handleError, ok } from "@/server/http";
import { deactivateBaby } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await deactivateBaby(params.id));
  } catch (error) {
    return handleError(error);
  }
}
