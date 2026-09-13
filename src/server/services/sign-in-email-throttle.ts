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
  observeFailureStage?: (stage: EmailSignInCarrierFailureStage) => void;
};

export type EmailSignInCarrierFailureStage = "lookup" | "lookup-miss" | "precheck" | "handler" | "failure-recording"
  | "unauthorized-user-not-found" | "unauthorized-credential-account-not-found" | "unauthorized-email-not-verified"
  | "unauthorized-failed-to-create-session" | "unauthorized-other" | "handler-ok" | "parse" | "invalid-credentials";

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

async function unauthorizedCarrierStage(response: Response): Promise<EmailSignInCarrierFailureStage> {
  let code: unknown;
  try {
    code = (await response.clone().json() as { code?: unknown }).code;
  } catch {
    return "unauthorized-other";
  }
  switch (code) {
    case "USER_NOT_FOUND": return "unauthorized-user-not-found";
    case "CREDENTIAL_ACCOUNT_NOT_FOUND": return "unauthorized-credential-account-not-found";
    case "EMAIL_NOT_VERIFIED": return "unauthorized-email-not-verified";
    case "FAILED_TO_CREATE_SESSION": return "unauthorized-failed-to-create-session";
    default: return "unauthorized-other";
  }
}

function evidenceUnavailable() {
  return new Response(JSON.stringify({ code: "security_sign_in_evidence_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function invokeNormalized(
  dependencies: Pick<EmailSignInThrottleCarrierDependencies, "invoke">,
  request: Request,
  observeFailureStage: (stage: EmailSignInCarrierFailureStage) => void
) {
  try {
    const response = await dependencies.invoke(request);
    if (response.status >= 500) {
      observeFailureStage("handler");
      return evidenceUnavailable();
    }
    // Positive control: proves the acceptance observer reaches the host on a successful sign-in.
    if (response.ok) observeFailureStage("handler-ok");
    return response;
  } catch {
    observeFailureStage("handler");
    return evidenceUnavailable();
  }
}

export async function runEmailSignInThrottleCarrier(
  request: Request,
  dependencies: EmailSignInThrottleCarrierDependencies
): Promise<Response> {
  let failureStageObserved = false;
  const observeFailureStage = (stage: EmailSignInCarrierFailureStage) => {
    if (failureStageObserved) return;
    failureStageObserved = true;
    try {
      dependencies.observeFailureStage?.(stage);
    } catch {
      // The diagnostic-only observer must never alter authentication behavior.
    }
  };
  const parsed = await parseStrictSignInBody(request);
  if (!parsed) {
    const response = await invokeNormalized(dependencies, request, observeFailureStage);
    // Strict-parse failures reach Better Auth without throttle evidence; mark any outcome not already staged.
    observeFailureStage("parse");
    return response;
  }

  let userId: string | undefined;
  try {
    userId = await dependencies.findUserIdByNormalizedEmail(parsed.normalizedEmail);
  } catch {
    observeFailureStage("lookup");
    return invokeNormalized(dependencies, syntheticNonexistentRequest(request, parsed.body), observeFailureStage);
  }

  // A missed lookup is not an error, but it decides whether a later invalid-credentials response can
  // record account-scoped evidence. Observing it as a fixed category separates the two outcomes.
  if (!userId) observeFailureStage("lookup-miss");

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
        observeFailureStage("failure-recording");
        return evidenceUnavailable();
      }
      return invokeNormalized(dependencies, syntheticNonexistentRequest(request, parsed.body), observeFailureStage);
    }
  } catch {
    observeFailureStage("precheck");
    return evidenceUnavailable();
  }

  const response = await invokeNormalized(dependencies, request, observeFailureStage);
  // A 401 that is not the invalid-credentials code comes from a different guard entirely. Reduce it to
  // a closed set of framework codes so the boundary is identifiable without retaining any response content.
  if (response.status === 401 && !(await isInvalidCredentials(response))) {
    observeFailureStage(await unauthorizedCarrierStage(response));
  }
  if (await isInvalidCredentials(response)) {
    try {
      await dependencies.recordFailure(input, userId);
    } catch {
      observeFailureStage("failure-recording");
      return evidenceUnavailable();
    }
    // Recorded invalid credentials otherwise leave no marker, which made them indistinguishable from silence.
    observeFailureStage("invalid-credentials");
  }
  return response;
}
