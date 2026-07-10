export type AuthClientError = {
  status?: number;
  code?: string;
  message?: string;
};

export function isSessionReauthenticationRequired(error: AuthClientError | null | undefined) {
  if (!error) return false;
  return (
    error.status === 403 ||
    error.code === "SESSION_NOT_FRESH" ||
    error.message?.toLowerCase().includes("session is not fresh") === true
  );
}

export function authFailureMessage(mode: "login" | "register", error: AuthClientError) {
  const rateLimited =
    error.status === 429 ||
    error.code === "TOO_MANY_REQUESTS" ||
    error.message?.toLowerCase().includes("too many requests") === true;

  if (rateLimited && mode === "login") {
    return "Too many sign-in requests. Wait 10 seconds and try again.";
  }
  if (rateLimited) return "Too many account requests. Wait 10 seconds and try again.";
  return error.message ?? "Authentication failed.";
}
