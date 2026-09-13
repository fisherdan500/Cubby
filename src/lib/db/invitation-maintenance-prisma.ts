import { PrismaClient } from "@prisma/client";

function invitationMaintenanceDatabaseUrl() {
  const raw = process.env.INVITATION_MAINTENANCE_DATABASE_URL;
  try {
    if (!raw && process.env.NEXT_PHASE === "phase-production-build") return "postgresql://cubby_invitation_maintenance_worker:build-only@127.0.0.1:1/cubby?schema=public";
    if (!raw) throw new Error();
    const parsed = new URL(raw);
    if (decodeURIComponent(parsed.username) !== "cubby_invitation_maintenance_worker" || !parsed.password) throw new Error();
    return raw;
  } catch {
    throw new Error("invitation_maintenance_database_unavailable");
  }
}

const globalForInvitationMaintenance = globalThis as unknown as { invitationMaintenancePrisma?: PrismaClient };
export const invitationMaintenancePrisma = globalForInvitationMaintenance.invitationMaintenancePrisma ?? new PrismaClient({
  datasourceUrl: invitationMaintenanceDatabaseUrl(),
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForInvitationMaintenance.invitationMaintenancePrisma = invitationMaintenancePrisma;
