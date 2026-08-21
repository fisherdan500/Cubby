import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";

export async function listHouseholdAuditEvents(limit = 50) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "household.manage");
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new Error("forbidden");

  const events = await prisma.auditEvent.findMany({
    where: { householdId: ctx.householdId },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      schemaVersion: true,
      correlationId: true,
      actorUserSnapshot: true,
      actorMemberSnapshot: true,
      createdAt: true
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 100)
  });

  await writeAudit(ctx, {
    action: "audit.view",
    entityType: "audit",
    entityId: ctx.householdId
  });

  return events;
}
