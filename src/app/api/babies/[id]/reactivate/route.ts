import { handleError, ok } from "@/server/http";
import { reactivateBaby } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    return ok(await reactivateBaby(params.id));
  } catch (error) {
    return handleError(error);
  }
}
