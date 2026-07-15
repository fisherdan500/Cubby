import { APIError, type BetterAuthOptions, type DBAdapter } from "better-auth";
import {
  ACCOUNT_DISABLED_CODE,
  ACCOUNT_DISABLED_MESSAGE
} from "@/server/auth/member-status";

export const ACCOUNT_DISABLED_SQLSTATE = "CUB01";

type AdapterFactory = (
  options: BetterAuthOptions
) => DBAdapter<BetterAuthOptions>;

export function withSuspendedSessionErrorTranslation(
  adapterFactory: AdapterFactory
): AdapterFactory {
  return (options) => {
    const adapter = adapterFactory(options);
    return {
      ...adapter,
      async create(input) {
        try {
          return await adapter.create(input);
        } catch (error) {
          if (input.model === "session" && isSuspendedSessionInsertError(error)) {
            throw new APIError("FORBIDDEN", {
              code: ACCOUNT_DISABLED_CODE,
              message: ACCOUNT_DISABLED_MESSAGE
            });
          }
          throw error;
        }
      }
    };
  };
}

function isSuspendedSessionInsertError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes(ACCOUNT_DISABLED_SQLSTATE) &&
    error.message.includes(ACCOUNT_DISABLED_MESSAGE)
  );
}
