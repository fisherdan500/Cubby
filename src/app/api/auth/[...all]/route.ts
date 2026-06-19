import { auth } from "@/lib/auth/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { signupPolicyForRequest } from "@/server/services/registration";

export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    const policy = await signupPolicyForRequest(request);
    if (!policy.allowed) {
      return NextResponse.json(
        {
          code: "REGISTRATION_CLOSED",
          message: "Account creation is invite-only for this Cubby instance."
        },
        { status: 403 }
      );
    }
  }
  return handlers.POST(request);
}
