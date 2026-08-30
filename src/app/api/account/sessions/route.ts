import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { handleError, ok } from "@/server/http";
import { listGlobalSessionSecurity } from "@/server/services/global-session-security";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await requireGlobalSecurityContext();
    const sessions = await listGlobalSessionSecurity(prisma, context);
    return ok({ sessions });
  } catch (error) {
    return handleError(error);
  }
}
