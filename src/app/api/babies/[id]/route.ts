import { handleError, ok } from "@/server/http";
import { deleteBaby, removeBabyProfile, updateBaby } from "@/server/services/households";

export const dynamic = "force-dynamic";

/** Change an existing baby's details. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const raw = await request.json() as Record<string, unknown>;
    return ok(await updateBaby(params.id, raw));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Delete a baby. `mode: "remove"` takes away an untouched profile for good and is refused the moment
 * anything references it; otherwise the baby and its history are hidden and stay recoverable.
 * Both require the exact typed phrase, which the service checks against the stored name.
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const raw = await request.json() as Record<string, unknown>;
    const input = { confirmation: raw.confirmation };
    return ok(raw.mode === "remove"
      ? await removeBabyProfile(params.id, input)
      : await deleteBaby(params.id, input));
  } catch (error) {
    return handleError(error);
  }
}
