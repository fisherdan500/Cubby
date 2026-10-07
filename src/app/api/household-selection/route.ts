import { NextResponse } from "next/server";
import { authorizedRequestOrigin, handleError } from "@/server/http";
import {
  SELECTED_HOUSEHOLD_MEMBER_COOKIE,
  selectedHouseholdCookieOptions
} from "@/server/auth/context";
import {
  authorizeHouseholdSelection,
  clearHouseholdSelection
} from "@/server/services/household-selection";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const requestOrigin = authorizedRequestOrigin(request, { requireOrigin: true });
    const form = await request.formData();
    const intent = form.get("intent");
    const returnTo = safeReturnTo(form.get("returnTo"));
    const response = NextResponse.redirect(new URL(returnTo, requestOrigin), 303);

    if (intent === "clear") {
      await clearHouseholdSelection();
      response.cookies.set(SELECTED_HOUSEHOLD_MEMBER_COOKIE, "", selectedHouseholdCookieOptions(requestOrigin, 0));
      return response;
    }

    const memberId = form.get("memberId");
    if (typeof memberId !== "string") throw new Error("validation_error");
    const context = await authorizeHouseholdSelection(memberId);
    response.cookies.set(
      SELECTED_HOUSEHOLD_MEMBER_COOKIE,
      context.memberId,
      selectedHouseholdCookieOptions(requestOrigin)
    );
    return response;
  } catch (error) {
    return handleError(error);
  }
}

function safeReturnTo(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "/app";
  return value === "/app" || value.startsWith("/app/") || value.startsWith("/app?") ? value : "/app";
}
