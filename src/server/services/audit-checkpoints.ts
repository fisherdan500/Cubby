import { verifyAuditChain } from "@/server/services/audit-integrity";

type AuditRow = {
  id: string;
  householdId: string;
  babyId?: string | null;
  actorUserId?: string | null;
  actorMemberId?: string | null;
  actorUserSnapshot?: string | null;
  actorMemberSnapshot?: string | null;
  correlationId?: string | null;
  chainOrder?: number;
  action: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  createdAt: Date;
  before: unknown;
  after: unknown;
  previousHash: string | null;
  eventHash: string | null;
};

type Checkpoint = { headHash: string; eventCount: number } | null;
export const AUDIT_GENESIS_HASH = "0".repeat(64);

type AuditCheckpointDatabase = {
  auditEvent: { findMany: (args: any) => Promise<AuditRow[]> };
  auditIntegrityCheckpoint: {
    findUnique: (args: any) => Promise<Checkpoint>;
    upsert?: (args: any) => Promise<unknown>;
  };
  $executeRaw?: (...args: any[]) => Promise<unknown>;
};

type AuditCheckpointRefreshDatabase = AuditCheckpointDatabase & {
  household: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  $transaction: <T>(operation: (tx: AuditCheckpointDatabase) => Promise<T>) => Promise<T>;
};

type PlatformAuditRow = {
  id: string;
  actorUserId?: string | null;
  actorUserSnapshot?: string | null;
  correlationId?: string | null;
  chainOrder?: number;
  source?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  createdAt: Date;
  before: unknown;
  after: unknown;
  previousHash: string | null;
  eventHash: string | null;
};
type PlatformCheckpointDatabase = {
  platformAuditEvent: { findMany: (args: any) => Promise<PlatformAuditRow[]> };
  auditIntegrityCheckpoint: { upsert: (args: any) => Promise<unknown> };
  $executeRaw?: (...args: any[]) => Promise<unknown>;
};

export type AuditCheckpointSchedulerDatabase = AuditCheckpointRefreshDatabase & PlatformCheckpointDatabase;

function toChain(events: AuditRow[]) {
  return events.map((event) => ({
    id: event.id,
    householdId: event.householdId,
    ...(event.schemaVersion >= 2 ? {
      babyId: event.babyId,
      actorUserId: event.actorUserId,
      actorMemberId: event.actorMemberId,
      actorUserSnapshot: event.actorUserSnapshot,
      actorMemberSnapshot: event.actorMemberSnapshot,
      correlationId: event.correlationId,
      ...(event.schemaVersion >= 3 ? { chainOrder: event.chainOrder } : {})
    } : {}),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt.toISOString(),
    before: event.before,
    after: event.after,
    previousHash: event.previousHash,
    eventHash: event.eventHash!
  }));
}

async function householdEvents(householdId: string, database: AuditCheckpointDatabase) {
  return database.auditEvent.findMany({
    where: { householdId },
    orderBy: { chainOrder: "asc" }
  });
}

export async function readHouseholdAuditIntegrity(householdId: string, database: AuditCheckpointDatabase) {
  const [events, checkpoint] = await Promise.all([
    householdEvents(householdId, database),
    database.auditIntegrityCheckpoint.findUnique({ where: { scope: `household:${householdId}` } })
  ]);
  if (!checkpoint) return { status: "missing" as const };
  if (events.some((event) => !event.eventHash)) return { status: "invalid" as const };
  if (events.length && !verifyAuditChain(toChain(events)).valid) return { status: "invalid" as const };
  const headHash = events.at(-1)?.eventHash ?? AUDIT_GENESIS_HASH;
  if (checkpoint.eventCount !== events.length || checkpoint.headHash !== headHash) return { status: "stale" as const };
  return { status: "valid" as const };
}

export async function refreshHouseholdAuditCheckpoint(householdId: string, database: AuditCheckpointDatabase, verifiedAt = new Date()) {
  if (typeof database.auditIntegrityCheckpoint.upsert !== "function") throw new Error("audit_checkpoint_writer_unavailable");
  if (typeof database.$executeRaw === "function") {
    await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit-chain:${householdId}`}))`;
  }
  const events = await householdEvents(householdId, database);
  if (events.some((event) => !event.eventHash)) {
    throw new Error("audit_checkpoint_chain_missing_hash");
  }
  const chain = events.length ? verifyAuditChain(toChain(events)) : { valid: true as const };
  if (!chain.valid) {
    throw new Error("audit_checkpoint_chain_invalid");
  }
  const headHash = events.at(-1)?.eventHash ?? AUDIT_GENESIS_HASH;
  await database.auditIntegrityCheckpoint.upsert({
    where: { scope: `household:${householdId}` },
    create: { scope: `household:${householdId}`, headHash, eventCount: events.length, verifiedAt },
    update: { headHash, eventCount: events.length, verifiedAt }
  });
  return { headHash, eventCount: events.length, verifiedAt };
}

export async function refreshActiveHouseholdAuditCheckpoints(database: AuditCheckpointRefreshDatabase, verifiedAt = new Date()) {
  const households = await database.household.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: "asc" } });
  let refreshed = 0;
  let rejected = 0;
  for (const household of households) {
    try {
      await database.$transaction((tx) => refreshHouseholdAuditCheckpoint(household.id, tx, verifiedAt));
      refreshed += 1;
    } catch {
      rejected += 1;
    }
  }
  return { refreshed, rejected };
}

export async function refreshPlatformAuditCheckpoint(database: PlatformCheckpointDatabase, verifiedAt = new Date()) {
  if (typeof database.$executeRaw === "function") {
    await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform-audit-chain'))`;
  }
  const events = await database.platformAuditEvent.findMany({
    orderBy: { chainOrder: "asc" },
    select: {
      id: true,
      actorUserId: true,
      actorUserSnapshot: true,
      action: true,
      entityType: true,
      entityId: true,
      schemaVersion: true,
      chainOrder: true,
      correlationId: true,
      source: true,
      createdAt: true,
      before: true,
      after: true,
      previousHash: true,
      eventHash: true
    }
  });
  if (events.some((event) => !event.eventHash)) throw new Error("platform_audit_checkpoint_chain_missing_hash");
  const chain = events.map((event) => ({
    id: event.id,
    householdId: "platform",
    ...(event.schemaVersion >= 2 ? {
      actorUserId: event.actorUserId,
      actorUserSnapshot: event.actorUserSnapshot,
      correlationId: event.correlationId,
      source: event.source,
      ...(event.schemaVersion >= 3 ? { chainOrder: event.chainOrder } : {})
    } : {}),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt.toISOString(),
    before: event.before,
    after: event.after,
    previousHash: event.previousHash,
    eventHash: event.eventHash!
  }));
  if (chain.length && !verifyAuditChain(chain).valid) throw new Error("platform_audit_checkpoint_chain_invalid");
  const headHash = events.at(-1)?.eventHash ?? AUDIT_GENESIS_HASH;
  await database.auditIntegrityCheckpoint.upsert({
    where: { scope: "platform" },
    create: { scope: "platform", headHash, eventCount: events.length, verifiedAt },
    update: { headHash, eventCount: events.length, verifiedAt }
  });
  return { headHash, eventCount: events.length, verifiedAt };
}
