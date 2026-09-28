import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db/prisma";
import { authPrisma } from "@/lib/db/auth-prisma";
import { env, trustedOrigins } from "@/lib/env";
import { assertUserCanStartSession } from "@/server/auth/member-status";
import { withSuspendedSessionErrorTranslation } from "@/server/auth/session-adapter";
import { initializeGlobalSessionSecurityActivity } from "@/server/services/global-session-security";
import { acceptanceBetterAuthLoggerOptions } from "@/server/auth/acceptance-sign-in-rejection";
import { verifyPassword } from "@better-auth/utils/password";
import {
  createPasswordSessionProof,
  passwordSessionProofAdditionalFields,
  verifyPasswordAndCaptureSessionProof
} from "@/server/auth/password-session-proof";

export const SESSION_FRESH_AGE_SECONDS = 60 * 10;

export const auth = betterAuth({
  database: withSuspendedSessionErrorTranslation(
    prismaAdapter(authPrisma, {
      provider: "postgresql"
    })
  ),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: trustedOrigins(),
  rateLimit: {
    enabled: false
  },
  emailAndPassword: {
    enabled: true,
    revokeSessionsOnPasswordReset: true,
    password: {
      verify: (input) => verifyPasswordAndCaptureSessionProof(verifyPassword, input)
    }
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          await assertUserCanStartSession(session);
          return { data: { ...session, ...createPasswordSessionProof(session) } };
        },
        after: async (session) => {
          await initializeGlobalSessionSecurityActivity(prisma, {
            userId: session.userId,
            sessionId: session.id
          });
        }
      }
    }
  },
  session: {
    additionalFields: passwordSessionProofAdditionalFields,
    expiresIn: 60 * 60 * 24 * 60,
    updateAge: 60 * 60 * 24,
    freshAge: SESSION_FRESH_AGE_SECONDS,
    cookieCache: {
      enabled: false
    }
  },
  user: {
    deleteUser: {
      enabled: false
    }
  },
  plugins: [nextCookies()],
  ...acceptanceBetterAuthLoggerOptions()
});

export type AuthSession = typeof auth.$Infer.Session;
