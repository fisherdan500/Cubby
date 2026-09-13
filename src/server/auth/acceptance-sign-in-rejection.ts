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

let lastRejection: BetterAuthSignInRejection | undefined;

export function acceptanceSignInRejectionObservationEnabled(environment: AcceptanceEnvironment = process.env) {
  return environment.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL === "1"
    && environment.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE === acceptanceCarrierStagePath;
}

export function observeBetterAuthSignInRejectionLog(level: string, message: unknown) {
  if (level !== "warn" || typeof message !== "string") return;
  const rejection = rejectionByWarning.get(message);
  if (rejection) lastRejection = rejection;
}

export function takeBetterAuthSignInRejection() {
  const rejection = lastRejection;
  lastRejection = undefined;
  return rejection;
}

export function acceptanceBetterAuthLoggerOptions(environment: AcceptanceEnvironment = process.env) {
  return acceptanceSignInRejectionObservationEnabled(environment)
    ? { logger: { level: "warn" as const, log: observeBetterAuthSignInRejectionLog } }
    : {};
}
