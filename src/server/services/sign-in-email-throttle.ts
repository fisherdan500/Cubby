import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalizeTrustedClient,
  normalizeThrottleAccountIdentifier,
  type GlobalSecurityThrottleInput,
  type GlobalSecurityThrottleResult
} from "@/server/services/global-security-throttling";

const emailSignInBody = z.object({
  email: z.string().email(),
  password: z.string()
}).passthrough();

export type EmailSignInThrottleCarrierDependencies = {
  throttleKey: string;
  trustedProxyHops: number;
  findUserIdByNormalizedEmail: (normalizedEmail: string) => Promise<string | undefined>;
  precheck: (input: GlobalSecurityThrottleInput) => Promise<GlobalSecurityThrottleResult>;
  recordFailure: (input: GlobalSecurityThrottleInput, eventUserId: string | undefined) => Promise<GlobalSecurityThrottleResult>;
  invoke: (request: Request) => Promise<Response>;
};

type ParsedSignIn = {
  body: Record<string, unknown>;
  normalizedEmail: string;
};

async function parseStrictSignInBody(request: Request): Promise<ParsedSignIn | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
  try {
    const parsed = emailSignInBody.safeParse(await request.clone().json());
    if (!parsed.success) return undefined;
    return { body: parsed.data, normalizedEmail: normalizeThrottleAccountIdentifier(parsed.data.email) };
  } catch {
    return undefined;
  }
}

function syntheticNonexistentRequest(request: Request, body: Record<string, unknown>) {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, email: `cubby-throttle-${randomUUID()}@invalid.test` })
  });
}

async function isInvalidCredentials(response: Response) {
  if (response.status !== 401) return false;
  try {
    return (await response.clone().json() as { code?: unknown }).code === "INVALID_EMAIL_OR_PASSWORD";
  } catch {
    return false;
  }
}

function evidenceUnavailable() {
  return new Response(JSON.stringify({ code: "security_sign_in_evidence_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function invokeNormalized(dependencies: Pick<EmailSignInThrottleCarrierDependencies, "invoke">, request: Request) {
  try {
    const response = await dependencies.invoke(request);
    return response.status >= 500 ? evidenceUnavailable() : response;
  } catch {
    return evidenceUnavailable();
  }
}

export async function runEmailSignInThrottleCarrier(
  request: Request,
  dependencies: EmailSignInThrottleCarrierDependencies
): Promise<Response> {
  const parsed = await parseStrictSignInBody(request);
  if (!parsed) return invokeNormalized(dependencies, request);

  let userId: string | undefined;
  try {
    userId = await dependencies.findUserIdByNormalizedEmail(parsed.normalizedEmail);
  } catch {
    return invokeNormalized(dependencies, syntheticNonexistentRequest(request, parsed.body));
  }

  const input: GlobalSecurityThrottleInput = {
    key: dependencies.throttleKey,
    userId,
    accountIdentifier: userId ? parsed.normalizedEmail : undefined,
    client: canonicalizeTrustedClient(dependencies.trustedProxyHops, request.headers.get("x-forwarded-for"))
  };

  try {
    if ((await dependencies.precheck(input)).quiet) {
      try {
        await dependencies.recordFailure(input, userId);
      } catch {
        return evidenceUnavailable();
      }
      return invokeNormalized(dependencies, syntheticNonexistentRequest(request, parsed.body));
    }
  } catch {
    return evidenceUnavailable();
  }

  const response = await invokeNormalized(dependencies, request);
  if (await isInvalidCredentials(response)) {
    try {
      await dependencies.recordFailure(input, userId);
    } catch {
      return evidenceUnavailable();
    }
  }
  return response;
}
