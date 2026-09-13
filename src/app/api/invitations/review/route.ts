import { handleInvitationRoute } from "@/server/services/invitation-route-layer";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleInvitationRoute(request, "review"); }
