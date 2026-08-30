import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { recordQualifyingGlobalSessionUseAfterSuccess } from "@/server/services/global-session-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return fail("session_activity_request_invalid", "The activity request is invalid.", 422);
    let body: unknown;
    try { body = await request.json(); } catch { return fail("session_activity_request_invalid", "The activity request is invalid.", 422); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as Record<string, unknown>).requestClass !== "foreground_document_navigation") return fail("session_activity_request_invalid", "The activity request is invalid.", 422);
    const context = await requireGlobalSecurityContext();
    await recordQualifyingGlobalSessionUseAfterSuccess(prisma, context, "foreground_document_navigation");
    return ok({ recorded: true });
  } catch (error) {
    return handleError(error);
  }
}
