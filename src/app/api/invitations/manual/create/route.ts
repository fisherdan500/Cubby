import { handleInvitationRoute } from "@/server/services/invitation-route-layer";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleInvitationRoute(request, "manual-create"); }
