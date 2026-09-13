import { PrismaClient } from "@prisma/client";

function invitationDatabaseUrl() {
  const raw = process.env.INVITATION_DATABASE_URL;
  try {
    if (!raw && process.env.NEXT_PHASE === "phase-production-build") return "postgresql://cubby_invitation_runtime:build-only@127.0.0.1:1/cubby?schema=public";
    if (!raw) throw new Error();
    const parsed = new URL(raw);
    if (decodeURIComponent(parsed.username) !== "cubby_invitation_runtime" || !parsed.password) throw new Error();
    return raw;
  } catch {
    throw new Error("invitation_database_unavailable");
  }
}

const globalForInvitation = globalThis as unknown as { invitationPrisma?: PrismaClient };
export const invitationPrisma = globalForInvitation.invitationPrisma ?? new PrismaClient({
  datasourceUrl: invitationDatabaseUrl(),
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForInvitation.invitationPrisma = invitationPrisma;
