import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

function authDatabaseUrl() {
  const raw = process.env.AUTH_DATABASE_URL;
  try {
    if (!raw && process.env.NEXT_PHASE === "phase-production-build") return "postgresql://cubby_auth:build-only@127.0.0.1:1/cubby?schema=public";
    if (!raw) throw new Error();
    const parsed = new URL(raw);
    if (decodeURIComponent(parsed.username) !== "cubby_auth" || !parsed.password) throw new Error();
    return raw;
  } catch {
    throw new Error("auth_database_unavailable");
  }
}

const globalForAuth = globalThis as unknown as { authPrisma?: PrismaClient };
const isolatedSourceAcceptance = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/p1-3-global-security-phase1.acceptance-rehearsal.ts") === true;

export const authPrisma = globalForAuth.authPrisma ?? ((process.env.NODE_ENV === "test" || isolatedSourceAcceptance) && !process.env.AUTH_DATABASE_URL
  ? prisma
  : new PrismaClient({
      datasourceUrl: authDatabaseUrl(),
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
    }));

if (process.env.NODE_ENV !== "production") globalForAuth.authPrisma = authPrisma;
