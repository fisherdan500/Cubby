import { NextResponse } from "next/server";
import { handleError } from "@/server/http";
import { SELECTED_HOUSEHOLD_MEMBER_COOKIE } from "@/server/auth/context";
import {
  authorizeHouseholdSelection,
  clearHouseholdSelection
} from "@/server/services/household-selection";

export const dynamic = "force-dynamic";

const persistentCandidateSeconds = 60 * 60 * 24 * 365;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const intent = form.get("intent");
    const returnTo = safeReturnTo(form.get("returnTo"));
    const response = NextResponse.redirect(new URL(returnTo, request.url), 303);

    if (intent === "clear") {
      await clearHouseholdSelection();
      response.cookies.set(SELECTED_HOUSEHOLD_MEMBER_COOKIE, "", cookieOptions(request, 0));
      return response;
    }

    const memberId = form.get("memberId");
    if (typeof memberId !== "string") throw new Error("validation_error");
    const context = await authorizeHouseholdSelection(memberId);
    response.cookies.set(
      SELECTED_HOUSEHOLD_MEMBER_COOKIE,
      context.memberId,
      cookieOptions(request, persistentCandidateSeconds)
    );
    return response;
  } catch (error) {
    return handleError(error);
  }
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("forbidden");
}

function safeReturnTo(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "/app";
  return value === "/app" || value.startsWith("/app/") || value.startsWith("/app?") ? value : "/app";
}

function cookieOptions(request: Request, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge
  };
}
