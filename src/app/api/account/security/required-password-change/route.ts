import { clearBetterAuthSessionCookies } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { completeRequiredPasswordChange } from "@/server/services/assisted-required-change";

export const dynamic = "force-dynamic";

function corridorError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "required_password_change_request_invalid") {
    return fail(code, "Enter your current password and matching new passwords.", 422);
  }
  if (code === "required_password_change_reuse") {
    return fail(code, "Choose a different password from the one you were given.", 422);
  }
  if (code === "current_password_invalid") {
    return fail(code, "The current password is incorrect.", 422);
  }
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("required_password_change_request_invalid");
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new Error("required_password_change_request_invalid");
    }
    const result = await completeRequiredPasswordChange(raw);
    await clearBetterAuthSessionCookies();
    return ok(result);
  } catch (error) {
    return corridorError(error);
  }
}
