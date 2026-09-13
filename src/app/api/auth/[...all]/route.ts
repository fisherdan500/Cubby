import { writeFileSync } from "node:fs";
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
import {
  runEmailSignInThrottleCarrier,
  type EmailSignInCarrierFailureStage
} from "@/server/services/sign-in-email-throttle";
import { takeBetterAuthSignInRejection } from "@/server/auth/acceptance-sign-in-rejection";

export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);
const acceptanceCarrierStagePath = "/run/cubby-acceptance-status/sign-in-carrier-stage";

function acceptanceCarrierFailureStageObserver() {
  if (
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL !== "1"
    || process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE !== acceptanceCarrierStagePath
  ) return undefined;
  // Discard any rejection category left by an earlier request so this request's marker stays causal.
  takeBetterAuthSignInRejection();
  return (observed: EmailSignInCarrierFailureStage) => {
    const allowed = ["lookup", "lookup-miss", "precheck", "handler", "failure-recording",
      "unauthorized-user-not-found", "unauthorized-credential-account-not-found", "unauthorized-email-not-verified",
      "unauthorized-failed-to-create-session", "unauthorized-other", "handler-ok", "parse", "invalid-credentials"];
    if (!allowed.includes(observed)) return;
    const stage = observed === "invalid-credentials"
      ? `invalid-credentials-${takeBetterAuthSignInRejection() ?? "unclassified"}`
      : observed;
    try {
      writeFileSync(acceptanceCarrierStagePath, `${stage}\n`, { encoding: "utf8", flag: "w", mode: 0o600 });
    } catch {
      // Acceptance observation must not alter the sign-in response or persistence.
    }
  };
}

async function canonicalSignInRequest(request: Request) {
  const parsed = await request.clone().json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  // The body is re-serialized, so the caller's length no longer applies.
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...body, callbackURL: "/invite/dispatch" }), signal: request.signal });
}

export async function GET() {
  return NextResponse.json({ code: "AUTH_ENDPOINT_NOT_AVAILABLE" }, { status: 404 });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/sign-in/email") {
    return NextResponse.json({ code: "AUTH_ENDPOINT_NOT_AVAILABLE" }, { status: 404 });
  }
  const observeFailureStage = acceptanceCarrierFailureStageObserver();
  return runEmailSignInThrottleCarrier(await canonicalSignInRequest(request), {
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
    invoke: handlers.POST,
    ...(observeFailureStage ? { observeFailureStage } : {})
  });
}
