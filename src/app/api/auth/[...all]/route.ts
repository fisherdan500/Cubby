import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import {
  configuredGlobalSecurityThrottleKey,
  precheckGlobalSecurityThrottle,
  recordGlobalSecurityThrottleFailureInTransaction,
  writeGlobalSecurityEvent
} from "@/server/services/global-security-throttling";
import { runEmailSignInThrottleCarrier } from "@/server/services/sign-in-email-throttle";

export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);

export async function GET() {
  return NextResponse.json({ code: "AUTH_ENDPOINT_NOT_AVAILABLE" }, { status: 404 });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/sign-in/email") {
    return NextResponse.json({ code: "AUTH_ENDPOINT_NOT_AVAILABLE" }, { status: 404 });
  }
  return runEmailSignInThrottleCarrier(request, {
    throttleKey: configuredGlobalSecurityThrottleKey(),
    trustedProxyHops: env.CUBBY_TRUSTED_PROXY_HOPS,
    findUserIdByNormalizedEmail: async (normalizedEmail) => {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User"
        WHERE "normalize_security_email_v1"("email")=${normalizedEmail}
        LIMIT 1
      `;
      return rows[0]?.id;
    },
    precheck: (input) => precheckGlobalSecurityThrottle(prisma, input),
    recordFailure: (input, eventUserId) => prisma.$transaction(async (tx) => {
      const result = await recordGlobalSecurityThrottleFailureInTransaction(tx, input);
      if (eventUserId) await writeGlobalSecurityEvent(tx, eventUserId, "credential", "sign_in_failed");
      return result;
    }, { isolationLevel: "Serializable" }),
    invoke: handlers.POST
  });
}
