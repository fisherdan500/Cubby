import { describe, expect, it } from "vitest";
import {
  acceptanceBetterAuthLoggerOptions,
  observeBetterAuthSignInRejectionLog,
  takeBetterAuthSignInRejection
} from "@/server/auth/acceptance-sign-in-rejection";

const exact = {
  CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL: "1",
  CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE: "/run/cubby-acceptance-status/sign-in-carrier-stage"
};

describe("acceptance Better Auth sign-in rejection observation", () => {
  it.each([
    ["User not found", "user-not-found"],
    ["Credential account not found", "credential-account-not-found"],
    ["Password not found", "password-not-found"],
    ["Invalid password", "password-mismatch"]
  ])("maps the fixed warning %j to %s and consumes it once", (message, rejection) => {
    takeBetterAuthSignInRejection();
    observeBetterAuthSignInRejectionLog("warn", message);
    expect(takeBetterAuthSignInRejection()).toBe(rejection);
    expect(takeBetterAuthSignInRejection()).toBeUndefined();
  });

  it("ignores other levels, unknown messages and non-string content", () => {
    takeBetterAuthSignInRejection();
    observeBetterAuthSignInRejectionLog("error", "Invalid password");
    observeBetterAuthSignInRejectionLog("warn", "Invalid password extra");
    observeBetterAuthSignInRejectionLog("warn", "constructor");
    observeBetterAuthSignInRejectionLog("warn", { message: "Invalid password" });
    expect(takeBetterAuthSignInRejection()).toBeUndefined();
  });

  it("attaches the logger only for the exact disposable acceptance guards", () => {
    expect(acceptanceBetterAuthLoggerOptions({})).toEqual({});
    expect(acceptanceBetterAuthLoggerOptions({ ...exact, CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL: "true" })).toEqual({});
    expect(acceptanceBetterAuthLoggerOptions({ ...exact, CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE: "/tmp/other" })).toEqual({});
    expect(acceptanceBetterAuthLoggerOptions(exact)).toEqual({ logger: { level: "warn", log: observeBetterAuthSignInRejectionLog } });
  });
});
