import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite } from "@/server/services/mutation-locks";

const babySafetyActions = [
  "activity.create",
  "activity.delete",
  "activity.timer.pause",
  "activity.timer.resume",
  "activity.timer.stop",
  "activity.undo",
  "activity.update",
  "baby.create",
  "baby.deactivate",
  "baby.reactivate"
];

type AuditPageOptions = { limit?: number; cursor?: string };
type AuditCursor = { createdAt: Date; id: string };

function safetyActivityType(after: unknown) {
  if (!after || typeof after !== "object" || Array.isArray(after)) return undefined;
  const type = (after as { type?: unknown }).type;
  return type === "medicine" || type === "vaccine" ? type : undefined;
}

function parsePageOptions(options: number | AuditPageOptions) {
  const input = typeof options === "number" ? { limit: options } : options;
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new Error("audit_limit_invalid");
  }
  const limit = input.limit ?? 50;
  if (!input.cursor) return { limit, cursor: null };
  try {
    const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof value.createdAt !== "string" || typeof value.id !== "string" || !value.id) throw new Error("invalid");
    const createdAt = new Date(value.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) throw new Error("invalid");
    return { limit, cursor: { createdAt, id: value.id } };
  } catch {
    throw new Error("audit_cursor_invalid");
  }
}

function serializeCursor(event: { id: string; createdAt: Date }) {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt.toISOString(), id: event.id })).toString("base64url");
}

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return `"${(value instanceof Date ? value.toISOString() : String(value)).replaceAll('"', '""')}"`;
}

export async function listHouseholdAuditEvents(options: number | AuditPageOptions = 50) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "household.manage");
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new Error("forbidden");
  const { limit, cursor } = parsePageOptions(options);
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "household.manage");
    if (lockedCtx.role !== "owner" && lockedCtx.role !== "admin") throw new Error("forbidden");
    const where = {
      householdId: lockedCtx.householdId,
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } }
        ]
      } : {})
    };
    const rows = await tx.auditEvent.findMany({
      where,
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
      take: limit + 1
    });
    const events = rows.slice(0, limit);
    const nextCursor = rows.length > limit && events.length ? serializeCursor(events.at(-1)!) : null;

    await writeAudit(lockedCtx, {
      action: "audit.view",
      entityType: "audit",
      entityId: lockedCtx.householdId
    }, tx);

    return { events, nextCursor };
  });
}

export async function listBabySafetyHistory(babyId: string, limit = 50) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "baby.manage");
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "baby.manage");
    const baby = await tx.baby.findFirst({
      where: { id: babyId, householdId: lockedCtx.householdId, deletedAt: null },
      select: { id: true }
    });
    if (!baby) return [];
    const events = await tx.auditEvent.findMany({
      where: {
        householdId: lockedCtx.householdId,
        babyId: baby.id,
        action: { in: babySafetyActions }
      },
      select: {
        action: true,
        actorUserSnapshot: true,
        actorMemberSnapshot: true,
        createdAt: true,
        after: true
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 100)
    });

    const projection = events.flatMap((event) => {
      const type = safetyActivityType(event.after);
      if (event.action.startsWith("activity.") && !type) return [];
      return [{
        action: event.action,
        actorUserSnapshot: event.actorUserSnapshot,
        actorMemberSnapshot: event.actorMemberSnapshot,
        createdAt: event.createdAt,
        ...(type ? { type } : {})
      }];
    });

    await writeAudit(lockedCtx, {
      action: "audit.view",
      entityType: "baby_safety_history",
      entityId: baby.id
    }, tx);

    return projection;
  });
}

export async function exportHouseholdAuditCsv() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "household.manage");
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new Error("forbidden");
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "household.manage");
    if (lockedCtx.role !== "owner" && lockedCtx.role !== "admin") throw new Error("forbidden");
    const events = await tx.auditEvent.findMany({
      where: { householdId: lockedCtx.householdId },
      select: {
        action: true,
        entityType: true,
        entityId: true,
        schemaVersion: true,
        correlationId: true,
        actorUserSnapshot: true,
        actorMemberSnapshot: true,
        createdAt: true
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    await writeAudit(lockedCtx, {
      action: "audit.export",
      entityType: "audit",
      entityId: lockedCtx.householdId
    }, tx);
    const headers = ["action", "entityType", "entityId", "schemaVersion", "correlationId", "actorUserSnapshot", "actorMemberSnapshot", "createdAt"];
    const rows = events.map((event) => [
      event.action,
      event.entityType,
      event.entityId,
      event.schemaVersion,
      event.correlationId,
      event.actorUserSnapshot,
      event.actorMemberSnapshot,
      event.createdAt
    ].map(csvValue).join(","));
    return [headers.map(csvValue).join(","), ...rows].join("\n");
  });
}
