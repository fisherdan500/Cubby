import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError } from "@/server/http";
import { exportGlobalSecurityHistory, globalSecurityHistoryExportFilename } from "@/server/services/global-security-history";

export const dynamic = "force-dynamic";

function parseConfirmation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("security_history_export_confirmation_required");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || body.confirmed !== true) throw new Error("security_history_export_confirmation_required");
}

function exportError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "security_history_export_confirmation_required") return fail(code, "Confirm the private security history export before downloading it.", 422);
  if (code === "security_history_export_too_large") return fail(code, "This security history export is too large to create.", 413);
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("security_history_export_confirmation_required");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new Error("security_history_export_confirmation_required");
    }
    parseConfirmation(body);
    const context = await requireGlobalSecurityContext();
    const payload = await exportGlobalSecurityHistory(prisma, context);
    return new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename=\"${globalSecurityHistoryExportFilename}\"`,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return exportError(error);
  }
}
