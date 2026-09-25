import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { HouseholdContext } from "@/server/auth/context";
import { hashAuditEvent } from "@/server/services/audit-integrity";

const auditActionSchema = z.enum([
  "activity.create",
  "activity.delete",
  "activity.timer.pause",
  "activity.timer.resume",
  "activity.timer.stop",
  "activity.undo",
  "activity.update",
  "attachment.activate",
  "attachment.delete",
  "attachment.purge",
  "attachment.reject",
  "attachment.restore",
  "attachment.stage",
  "attachment.unavailable",
  "attachment.view",
  "audit.export",
  "audit.view",
  "api_key.create",
  "api_key.revoke",
  "baby.create",
  "baby.deactivate",
  "baby.reactivate",
  "backup.recovery.authorize",
  "backup.recovery.target.provision",
  "backup.export",
  "backup.restore",
  "household.create",
  "calendar_event.create",
  "export.csv",
  "feed_comment.create",
  "feed_comment.delete",
  "feed_comment.update",
  "feed_post.create",
  "feed_post.delete",
  "feed_post.restore",
  "feed_post.update",
  "feed_reaction.set",
  "invite.accept",
  "invite.conflict",
  "invite.create",
  "invite.emergency_revoke",
  "invite.emergency_revoke_all",
  "invite.expire",
  "invite.revoke",
  "invite.rotate",
  "member.admin.grant",
  "member.admin.revoke",
  "member.remove",
  "member.role.update",
  "member.restore",
  "member.self_leave",
  "member.suspend",
  "notification.preference.save",
  "planned_schedule.save",
  "push_subscription.save",
  "settings.appearance.update",
  "settings.units.update",
  "webhook.create",
  "webhook.delete"
]);

const platformAuditActionSchema = z.enum([
  "platform.backup_recovery.authorize",
  "platform.backup_recovery.target.provision",
  "platform.email.test",
  "platform.owner.bootstrap",
  "platform.owner.bootstrap_user.verify",
  "platform.owner.recover",
  "platform.owner.setup_claim",
  "platform.owner.successor_user.verify",
  "platform.registration.update"
]);

const activityAuditPayloadSchema = z.object({
  type: z.string().min(1).max(80).optional(),
  timerState: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(80).optional(),
  deletedAt: z.string().datetime().nullable().optional(),
  // Undo-last reads this back as the revision it is allowed to undo (auditActivityState), so the
  // payload has to carry it. It is a timestamp of the same row the entry already identifies, in
  // keeping with the minimization the rest of this schema enforces.
  updatedAt: z.string().datetime().optional()
}).strict();

const memberSelfLeaveBeforeSchema = z.object({
  role: z.string().min(1).max(80)
}).strict();

const auditTimestampSchema = z.union([z.string().datetime(), z.date()]).transform((value) => value instanceof Date ? value.toISOString() : value);

const memberSelfLeaveAfterSchema = z.object({
  closureReason: z.literal("self_left"),
  deletedAt: auditTimestampSchema,
  leaveOperationId: z.string().min(1).max(200),
  revokedApiKeyCount: z.number().int().nonnegative()
}).strict();

const emptyAuditPayloadSchema = z.object({}).strict();
const roleSchema = z.string().min(1).max(80);
const statusSchema = z.string().min(1).max(80);
const correlationIdSchema = z.string().min(1).max(200);
const inviteBeforeSchema = z.object({ role: roleSchema, status: statusSchema }).strict();
const inviteAfterSchema = z.object({
  role: roleSchema.optional(),
  status: statusSchema.optional(),
  expiresAt: auditTimestampSchema.optional(),
  expiredAt: auditTimestampSchema.optional(),
  revokedAt: auditTimestampSchema.optional(),
  revokedCount: z.number().int().nonnegative().optional(),
  reason: statusSchema.optional()
}).strict();
const memberBeforeSchema = z.object({
  role: roleSchema,
  disabledAt: auditTimestampSchema.nullable().optional()
}).strict();
const memberAfterSchema = z.object({
  role: roleSchema.optional(),
  disabledAt: auditTimestampSchema.nullable().optional(),
  deletedAt: auditTimestampSchema.nullable().optional(),
  revokedApiKeyCount: z.number().int().nonnegative().optional()
}).strict();
const babyLifecycleSchema = z.object({ inactiveAt: auditTimestampSchema.nullable().optional() }).strict();
const appearanceSchema = z.object({ accentTheme: z.string().min(1).max(80).nullable().optional() }).strict();
const calendarCreateSchema = z.object({
  babyId: z.string().min(1).max(200),
  startTime: auditTimestampSchema,
  endTime: auditTimestampSchema.nullable()
}).strict();
const webhookCreateSchema = z.object({ events: z.array(z.string().min(1).max(80)).max(20) }).strict();
const notificationPreferenceSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: statusSchema,
  externalDeliveryEnabled: z.boolean(),
  babyScope: z.enum(["all", "selected"])
}).strict();
// A plan's labels, times and notes are private caregiver text; the audit keeps only that it changed.
// A post's caption and tags are private family text; the audit keeps only how many tags it had.
const feedPostCreateSchema = z.object({
  tagCount: z.number().int().nonnegative(),
  photoCount: z.number().int().positive().max(10).optional()
}).strict();
// Attachment events (DEC-PROD-147) carry the type, safe counts and a fixed reason - never a filename,
// path, checksum, size, bytes or anything the uploader supplied.
const attachmentAuditSchema = z.object({
  type: z.enum(["feed_photo"]),
  count: z.number().int().nonnegative().optional(),
  unavailableCount: z.number().int().nonnegative().optional(),
  reason: z.enum(["unsupported_format", "too_large", "bytes_missing", "bytes_mismatch", "expired", "unclaimed"]).optional()
}).strict();
// A comment's words are private family text too: the audit keeps only what it was on.
const feedCommentCreateSchema = z.object({ parentKind: z.enum(["post", "activity"]) }).strict();
const feedReactionSetSchema = z.object({
  reaction: z.enum(["love", "funny", "aww", "celebrate", "well_done"]),
  on: z.boolean()
}).strict();
const plannedScheduleSchema = z.object({
  revision: z.number().int().positive(),
  itemCount: z.number().int().nonnegative()
}).strict();

type AuditWriteDb = Pick<Prisma.TransactionClient, "auditEvent"> & {
  auditIntegrityCheckpoint?: Pick<Prisma.TransactionClient["auditIntegrityCheckpoint"], "upsert">;
  $executeRaw?: Prisma.TransactionClient["$executeRaw"];
};

function minimizeAuditPayload(
  action: z.infer<typeof auditActionSchema>,
  payload: Prisma.InputJsonValue | undefined,
  phase: "before" | "after"
) {
  if (payload === undefined) return undefined;
  if (action.startsWith("activity.")) {
    return activityAuditPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "member.self_leave") {
    return (phase === "before" ? memberSelfLeaveBeforeSchema : memberSelfLeaveAfterSchema).parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "api_key.create" || action === "api_key.revoke") {
    return emptyAuditPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action.startsWith("invite.")) {
    return (phase === "before" ? inviteBeforeSchema : inviteAfterSchema).parse(payload) as Prisma.InputJsonValue;
  }
  if (action.startsWith("member.")) {
    return (phase === "before" ? memberBeforeSchema : memberAfterSchema).parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "baby.create" || action === "baby.deactivate" || action === "baby.reactivate") {
    return babyLifecycleSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "settings.appearance.update") {
    return appearanceSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "calendar_event.create") {
    return calendarCreateSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "webhook.create") {
    return webhookCreateSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (
    action === "webhook.delete"
    || action === "settings.units.update"
    || action === "backup.export"
    || action === "backup.restore"
    || action === "backup.recovery.authorize"
    || action === "backup.recovery.target.provision"
    || action === "household.create"
    || action === "export.csv"
    || action === "audit.export"
    || action === "audit.view"
    || action === "push_subscription.save"
  ) {
    return emptyAuditPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "notification.preference.save") {
    return notificationPreferenceSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "planned_schedule.save") {
    return plannedScheduleSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "feed_post.create" || action === "feed_post.update") {
    return feedPostCreateSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action.startsWith("attachment.")) {
    return attachmentAuditSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "feed_comment.create") {
    return feedCommentCreateSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "feed_reaction.set") {
    return feedReactionSetSchema.parse(payload) as Prisma.InputJsonValue;
  }
  if (action === "feed_post.delete" || action === "feed_post.restore" || action === "feed_comment.update" || action === "feed_comment.delete") {
    return emptyAuditPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  }
  return payload;
}

export async function writeAudit(
  ctx: { householdId: string; userId: string | null; memberId?: string | null; role?: HouseholdContext["role"] },
  input: {
    action: string;
    entityType: string;
    entityId: string;
    babyId?: string;
    correlationId?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
  db: AuditWriteDb = prisma
) {
  const action = auditActionSchema.safeParse(input.action);
  if (!action.success) throw new Error("audit_action_unclassified");
  const before = minimizeAuditPayload(action.data, input.before, "before");
  const after = minimizeAuditPayload(action.data, input.after, "after");
  const correlationId = input.correlationId === undefined ? null : correlationIdSchema.parse(input.correlationId);
  const id = randomUUID();
  if (typeof db.$executeRaw === "function") {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit-chain:${ctx.householdId}`}))`;
  }
  const createdAt = new Date();
  const chainOrder = (typeof db.auditEvent.count === "function"
    ? await db.auditEvent.count({ where: { householdId: ctx.householdId } })
    : 0) + 1;
  const findLatest = db.auditEvent.findFirst;
  const previous = typeof findLatest === "function"
    ? await findLatest.call(db.auditEvent, {
        where: { householdId: ctx.householdId, eventHash: { not: null } },
        select: { eventHash: true },
        orderBy: { chainOrder: "desc" }
      })
    : null;
  const previousHash = previous?.eventHash ?? null;
  const eventHash = hashAuditEvent(previousHash, {
    id,
    householdId: ctx.householdId,
    babyId: input.babyId ?? null,
    actorUserId: ctx.userId,
    actorMemberId: ctx.memberId ?? null,
    actorUserSnapshot: ctx.userId,
    actorMemberSnapshot: ctx.memberId ?? null,
    correlationId,
    chainOrder,
    action: action.data,
    entityType: input.entityType,
    entityId: input.entityId,
    schemaVersion: 3,
    createdAt: createdAt.toISOString(),
    before: before ?? null,
    after: after ?? null
  });
  await db.auditEvent.create({
    data: {
      id,
      householdId: ctx.householdId,
      babyId: input.babyId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      actorUserSnapshot: ctx.userId,
      actorMemberSnapshot: ctx.memberId,
      correlationId,
      chainOrder,
      action: action.data,
      entityType: input.entityType,
      entityId: input.entityId,
      schemaVersion: 3,
      previousHash,
      eventHash,
      before,
      after,
      createdAt
    }
  });
  if (db.auditIntegrityCheckpoint) {
    const eventCount = await db.auditEvent.count({ where: { householdId: ctx.householdId } });
    await db.auditIntegrityCheckpoint.upsert({
      where: { scope: `household:${ctx.householdId}` },
      create: { scope: `household:${ctx.householdId}`, headHash: eventHash, eventCount, verifiedAt: createdAt },
      update: { headHash: eventHash, eventCount, verifiedAt: createdAt }
    });
  }
}

export async function writePlatformAudit(
  input: {
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string | null;
    source?: string;
    correlationId?: string;
  },
  db: {
    platformAuditEvent: {
      create: (args: { data: Prisma.PlatformAuditEventCreateInput }) => Promise<{ id: string }>;
      count?: (args: { where?: object }) => Promise<number>;
      findFirst?: (args: { where: { eventHash: { not: null } }; select: { eventHash: true }; orderBy: { chainOrder: "desc" } }) => Promise<{ eventHash: string | null } | null>;
    };
    auditIntegrityCheckpoint?: Pick<Prisma.TransactionClient["auditIntegrityCheckpoint"], "upsert">;
    $executeRaw?: Prisma.TransactionClient["$executeRaw"];
  } = prisma
) {
  const action = platformAuditActionSchema.safeParse(input.action);
  if (!action.success) throw new Error("platform_audit_action_unclassified");
  const correlationId = input.correlationId === undefined ? null : correlationIdSchema.parse(input.correlationId);
  const id = randomUUID();
  const source = input.source ?? "application";
  if (typeof db.$executeRaw === "function") {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform-audit-chain'))`;
  }
  const createdAt = new Date();
  const chainOrder = (await db.platformAuditEvent.count?.({}) ?? 0) + 1;
  const previous = typeof db.platformAuditEvent.findFirst === "function"
    ? await db.platformAuditEvent.findFirst({
        where: { eventHash: { not: null } },
        select: { eventHash: true },
        orderBy: { chainOrder: "desc" }
      })
    : null;
  const previousHash = previous?.eventHash ?? null;
  const eventHash = hashAuditEvent(previousHash, {
    id,
    householdId: "platform",
    actorUserId: input.actorUserId ?? null,
    actorUserSnapshot: input.actorUserId ?? null,
    correlationId,
    source,
    chainOrder,
    action: action.data,
    entityType: input.entityType,
    entityId: input.entityId,
    schemaVersion: 3,
    createdAt: createdAt.toISOString(),
    before: null,
    after: null
  });
  const event = await db.platformAuditEvent.create({
    data: {
      id,
      actorUserId: input.actorUserId ?? null,
      actorUserSnapshot: input.actorUserId ?? null,
      action: action.data,
      entityType: input.entityType,
      entityId: input.entityId,
      source,
      chainOrder,
      schemaVersion: 3,
      correlationId,
      previousHash,
      eventHash,
      createdAt
    }
  });
  if (db.auditIntegrityCheckpoint && typeof db.platformAuditEvent.count === "function") {
    const eventCount = await db.platformAuditEvent.count({});
    await db.auditIntegrityCheckpoint.upsert({
      where: { scope: "platform" },
      create: { scope: "platform", headHash: eventHash, eventCount, verifiedAt: createdAt },
      update: { headHash: eventHash, eventCount, verifiedAt: createdAt }
    });
  }
  return event;
}
