import { AsyncLocalStorage } from "node:async_hooks";

// Diagnostic-only mapping from Better Auth's fixed email sign-in warnings to closed rejection categories.
// It is attached solely inside the disposable acceptance runtime and never retains log content.
export type BetterAuthSignInRejection = "user-not-found" | "credential-account-not-found" | "password-not-found" | "password-mismatch";

const acceptanceCarrierStagePath = "/run/cubby-acceptance-status/sign-in-carrier-stage";
const rejectionByWarning = new Map<string, BetterAuthSignInRejection>([
  ["User not found", "user-not-found"],
  ["Credential account not found", "credential-account-not-found"],
  ["Password not found", "password-not-found"],
  ["Invalid password", "password-mismatch"]
]);

type AcceptanceEnvironment = Readonly<Record<string, string | undefined>>;

// Each acceptance sign-in request keeps its own category, so concurrent requests cannot read each other's.
const requestScope = new AsyncLocalStorage<{ rejection?: BetterAuthSignInRejection }>();

export function acceptanceSignInRejectionObservationEnabled(environment: AcceptanceEnvironment = process.env) {
  return environment.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL === "1"
    && environment.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE === acceptanceCarrierStagePath;
}

export function runWithBetterAuthSignInRejectionScope<T>(action: () => T): T {
  return requestScope.run({}, action);
}

export function observeBetterAuthSignInRejectionLog(level: string, message: unknown) {
  if (level !== "warn" || typeof message !== "string") return;
  const scope = requestScope.getStore();
  const rejection = rejectionByWarning.get(message);
  if (scope && rejection) scope.rejection = rejection;
}

export function takeBetterAuthSignInRejection() {
  const scope = requestScope.getStore();
  const rejection = scope?.rejection;
  if (scope) scope.rejection = undefined;
  return rejection;
}

export function acceptanceBetterAuthLoggerOptions(environment: AcceptanceEnvironment = process.env) {
  return acceptanceSignInRejectionObservationEnabled(environment)
    ? { logger: { level: "warn" as const, log: observeBetterAuthSignInRejectionLog } }
    : {};
}
