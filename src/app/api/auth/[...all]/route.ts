import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";
import { signupPolicyForRequest } from "@/server/services/registration";

export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
      const policy = await signupPolicyForRequest(request, tx);
      if (!policy.allowed) {
        return NextResponse.json(
          {
            code: "REGISTRATION_CLOSED",
            message: "Account creation is invite-only for this Cubby instance."
          },
          { status: 403 }
        );
      }
      return handlers.POST(request);
    });
  }
  return handlers.POST(request);
}
