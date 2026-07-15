import { handleError, ok } from "@/server/http";
import { restoreMember } from "@/server/services/invites";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return ok(await restoreMember(id));
  } catch (error) {
    return handleError(error);
  }
}
