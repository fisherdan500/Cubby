import { PrismaClient } from "@prisma/client";

function invitationExpiryDatabaseUrl() {
  const raw = process.env.INVITATION_EXPIRY_DATABASE_URL;
  try {
    if (!raw && process.env.NEXT_PHASE === "phase-production-build") return "postgresql://cubby_invitation_expiry_worker:build-only@127.0.0.1:1/cubby?schema=public";
    if (!raw) throw new Error();
    const parsed = new URL(raw);
    if (decodeURIComponent(parsed.username) !== "cubby_invitation_expiry_worker" || !parsed.password) throw new Error();
    return raw;
  } catch {
    throw new Error("invitation_expiry_database_unavailable");
  }
}

const globalForInvitationExpiry = globalThis as unknown as { invitationExpiryPrisma?: PrismaClient };
export const invitationExpiryPrisma = globalForInvitationExpiry.invitationExpiryPrisma ?? new PrismaClient({
  datasourceUrl: invitationExpiryDatabaseUrl(),
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForInvitationExpiry.invitationExpiryPrisma = invitationExpiryPrisma;
