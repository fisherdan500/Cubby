import { handleError, ok } from "@/server/http";
import { suspendMember } from "@/server/services/invites";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return ok(await suspendMember(id));
  } catch (error) {
    return handleError(error);
  }
}
