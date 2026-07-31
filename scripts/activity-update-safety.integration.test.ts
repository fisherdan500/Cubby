import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, HouseholdRole, Prisma, TimerState, WebhookEvent } from "@prisma/client";

const auth = vi.hoisted(() => ({
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
  afterInitialContext: null as null | (() => Promise<void>)
}));

vi.mock("@/server/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/context")>();
  return {
    ...actual,
    getHouseholdContext: vi.fn(async () => {
      if (!auth.context) throw new Error("activity_update_safety_context_not_set");
      // Return the captured request context only after a test-controlled concurrent
      // membership change has committed. The real service must reject that stale
      // context when it locks and reauthorizes the actor inside its transaction.
      const initialContext = auth.context;
      const afterInitialContext = auth.afterInitialContext;
      auth.afterInitialContext = null;
      if (afterInitialContext) await afterInitialContext();
      return initialContext;
    })
  };
});

import { prisma } from "@/lib/db/prisma";
import { deleteActivity, pauseTimer, resumeTimer, stopTimer, updateActivity } from "@/server/services/activities";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("activity update safety disposable PostgreSQL acceptance", () => {
  it("rejects a timer stop when membership is suspended after request context capture without durable effects", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Transaction Reauthorization Owner",
        email: "transaction-reauthorization-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Transaction Reauthorization Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Transaction Reauthorization Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Transaction Reauthorization Baby", timezone: "UTC" }
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        householdId: household.id,
        legacyUnattributed: true,
        name: "Transaction Reauthorization Webhook",
        url: "https://acceptance.invalid/transaction-reauthorization",
        secret: "acceptance-transaction-reauthorization-secret",
        events: [WebhookEvent.timer_stopped]
      }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T09:00:00.000Z"),
        startedAt: new Date("2026-07-31T09:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const clientMutationId = "1d1ad9f5-0f1a-4e2f-91f7-ec4b95a7fb01";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };
    auth.afterInitialContext = async () => {
      await prisma.householdMember.update({ where: { id: member.id }, data: { disabledAt: new Date() } });
    };

    await expect(stopTimer(activity.id, { clientMutationId })).rejects.toThrow("forbidden");

    const [receiptCount, auditCount, webhookCount, activityAfterRejection, memberAfterSuspension] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.count({ where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } }),
      prisma.householdMember.findUniqueOrThrow({ where: { id: member.id } })
    ]);
    expect(memberAfterSuspension.disabledAt).toBeInstanceOf(Date);
    expect(receiptCount).toBe(0);
    expect(auditCount).toBe(0);
    expect(webhookCount).toBe(0);
    expect(activityAfterRejection).toMatchObject({
      id: activity.id,
      timerState: TimerState.running,
      endedAt: null,
      pausedAt: null,
      pausedSeconds: 0
    });
  });

  it("persists one stopped-timer receipt, audit, and pending webhook delivery when a matching stop is retried", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Stopped Timer Receipt Owner",
        email: "stopped-timer-receipt-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Stopped Timer Receipt Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Stopped Timer Receipt Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Stopped Timer Receipt Baby", timezone: "UTC" }
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        householdId: household.id,
        legacyUnattributed: true,
        name: "Stopped Timer Receipt Webhook",
        url: "https://acceptance.invalid/stopped-timer-receipt",
        secret: "acceptance-stopped-timer-receipt-secret",
        events: [WebhookEvent.timer_stopped]
      }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T15:00:00.000Z"),
        startedAt: new Date("2026-07-31T15:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const clientMutationId = "5a6e2418-2191-4324-ae1d-5f1e38031910";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const initial = await stopTimer(activity.id, { clientMutationId });
    const [receiptAfterInitial, auditsAfterInitial, deliveriesAfterInitial] = await Promise.all([
      prisma.mutationReceipt.findMany({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.findMany({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.findMany({
        where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id }
      })
    ]);
    expect(receiptAfterInitial).toHaveLength(1);
    expect(receiptAfterInitial[0]).toMatchObject({
      actorMemberId: member.id,
      operation: "timer.stop",
      targetActivityId: activity.id,
      outcomeActivityId: activity.id
    });
    expect(auditsAfterInitial).toHaveLength(1);
    expect(deliveriesAfterInitial).toHaveLength(1);
    const immutableReceiptSnapshot = Object.freeze(JSON.parse(JSON.stringify(receiptAfterInitial[0]!.outcomeSnapshot)));
    expect(JSON.parse(JSON.stringify(initial))).toEqual(immutableReceiptSnapshot);
    expect(deliveriesAfterInitial[0]).toMatchObject({ status: "pending", attemptCount: 0, nextAttemptAt: null });

    // This is a deliberately direct database mutation, not a service call. A completed
    // receipt is a replay ledger entry, so no identity, fingerprint, target, or outcome
    // field may be altered once its outcome snapshot has been written.
    await expect(prisma.$executeRaw`
      UPDATE "MutationReceipt"
      SET
        "id" = ${`${receiptAfterInitial[0]!.id}-tampered`},
        "householdId" = ${household.id},
        "actorMemberId" = ${member.id},
        "operation" = ${"tampered.operation"},
        "targetActivityId" = ${"tampered-target"},
        "clientMutationId" = ${`${clientMutationId}-tampered`},
        "intentFingerprint" = ${"tampered-fingerprint"},
        "outcomeActivityId" = ${"tampered-outcome"},
        "outcomeSnapshot" = ${JSON.stringify({ tampered: true })}::jsonb
      WHERE "id" = ${receiptAfterInitial[0]!.id}
    `).rejects.toThrow("completed_mutation_receipt_immutable");
    await expect(prisma.$executeRaw`
      DELETE FROM "MutationReceipt" WHERE "id" = ${receiptAfterInitial[0]!.id}
    `).rejects.toThrow("completed_mutation_receipt_immutable");

    const receiptAfterDirectMutationAttempts = await prisma.mutationReceipt.findUniqueOrThrow({
      where: { id: receiptAfterInitial[0]!.id }
    });
    expect(receiptAfterDirectMutationAttempts).toMatchObject({
      id: receiptAfterInitial[0]!.id,
      householdId: household.id,
      actorMemberId: member.id,
      operation: "timer.stop",
      targetActivityId: activity.id,
      clientMutationId,
      outcomeActivityId: activity.id,
      outcomeSnapshot: immutableReceiptSnapshot
    });
    expect(receiptAfterDirectMutationAttempts.intentFingerprint).not.toBe("tampered-fingerprint");

    const retry = await stopTimer(activity.id, { clientMutationId });
    expect(retry).toEqual(immutableReceiptSnapshot);

    const [receiptCountAfterRetry, auditCountAfterRetry, deliveriesAfterRetry] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.findMany({
        where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id }
      })
    ]);
    expect(receiptCountAfterRetry).toBe(1);
    expect(auditCountAfterRetry).toBe(1);
    expect(deliveriesAfterRetry).toHaveLength(1);
    expect(deliveriesAfterRetry[0]).toMatchObject({ status: "pending", attemptCount: 0, nextAttemptAt: null });
  });

  it("concurrently replays a seeded timer-pause command from its stored result without duplicate receipt or audit effects", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Timer Replay Owner",
        email: "timer-replay-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Timer Replay Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Timer Replay Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Timer Replay Baby", timezone: "UTC" }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T10:00:00.000Z"),
        startedAt: new Date("2026-07-31T10:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const clientMutationId = "3d6554fd-f2bc-4950-92e0-a4e0590eccf1";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const [firstAttempt, concurrentAttempt] = await Promise.all([
      pauseTimer(activity.id, { clientMutationId }),
      pauseTimer(activity.id, { clientMutationId })
    ]);
    expect(firstAttempt).toMatchObject({ id: activity.id, timerState: TimerState.paused });

    const receiptAfterConcurrentAttempts = await prisma.mutationReceipt.findMany({
      where: { householdId: household.id, clientMutationId }
    });
    const auditsAfterConcurrentAttempts = await prisma.auditEvent.findMany({
      where: { householdId: household.id, action: "activity.timer.pause", entityId: activity.id }
    });
    const activityAfterConcurrentAttempts = await prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } });
    expect(receiptAfterConcurrentAttempts).toHaveLength(1);
    expect(auditsAfterConcurrentAttempts).toHaveLength(1);
    expect(receiptAfterConcurrentAttempts[0]).toMatchObject({
      actorMemberId: member.id,
      operation: "timer.pause",
      targetActivityId: activity.id,
      outcomeActivityId: activity.id
    });
    expect(JSON.parse(JSON.stringify(firstAttempt))).toEqual(receiptAfterConcurrentAttempts[0]!.outcomeSnapshot);
    expect(JSON.parse(JSON.stringify(concurrentAttempt))).toEqual(receiptAfterConcurrentAttempts[0]!.outcomeSnapshot);

    const retry = await pauseTimer(activity.id, { clientMutationId });
    expect(retry).toEqual(receiptAfterConcurrentAttempts[0]!.outcomeSnapshot);

    const [receiptCountAfterRetry, auditCountAfterRetry, activityAfterRetry] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.pause", entityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } })
    ]);
    expect(receiptCountAfterRetry).toBe(1);
    expect(auditCountAfterRetry).toBe(1);
    expect(activityAfterRetry).toMatchObject({ id: activity.id, timerState: TimerState.paused });
    expect(activityAfterRetry.updatedAt).toEqual(activityAfterConcurrentAttempts.updatedAt);
  });

  it("replays a timer command from its immutable receipt after the target is soft-deleted", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Deleted Timer Replay Owner",
        email: "deleted-timer-replay-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Deleted Timer Replay Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Deleted Timer Replay Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Deleted Timer Replay Baby", timezone: "UTC" }
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        householdId: household.id,
        legacyUnattributed: true,
        name: "Deleted Timer Replay Webhook",
        url: "https://acceptance.invalid/timer-replay",
        secret: "acceptance-timer-replay-secret",
        events: [WebhookEvent.timer_stopped]
      }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T13:00:00.000Z"),
        startedAt: new Date("2026-07-31T13:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const timerMutationId = "e3b5cbe9-f18a-4c1c-8a90-48a0a1c8e201";
    const deleteMutationId = "018a4d97-213d-451a-a3df-4b5c48dc69a4";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const initialTimerOutcome = await stopTimer(activity.id, { clientMutationId: timerMutationId });
    expect(initialTimerOutcome).toMatchObject({ id: activity.id, timerState: TimerState.stopped, deletedAt: null });

    const timerReceipt = await prisma.mutationReceipt.findFirstOrThrow({
      where: { householdId: household.id, clientMutationId: timerMutationId }
    });
    const timerAuditsBeforeDelete = await prisma.auditEvent.findMany({
      where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id }
    });
    expect(timerAuditsBeforeDelete).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(initialTimerOutcome))).toEqual(timerReceipt.outcomeSnapshot);

    const deleted = await deleteActivity(activity.id, { clientMutationId: deleteMutationId });
    expect(deleted).toMatchObject({ id: activity.id });
    expect(deleted.deletedAt).toBeInstanceOf(Date);

    const targetAfterDelete = await prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } });
    const [timerReceiptCountBeforeReplay, timerAuditCountBeforeReplay, sideEffectCountBeforeReplay] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId: timerMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.count({ where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id } })
    ]);
    expect(targetAfterDelete.deletedAt).toBeInstanceOf(Date);
    expect(timerReceiptCountBeforeReplay).toBe(1);
    expect(timerAuditCountBeforeReplay).toBe(1);
    expect(sideEffectCountBeforeReplay).toBe(1);

    const replay = await stopTimer(activity.id, { clientMutationId: timerMutationId });
    expect(replay).toEqual(timerReceipt.outcomeSnapshot);
    expect(replay).toMatchObject({ id: activity.id, timerState: TimerState.stopped, deletedAt: null });

    const [timerReceiptCountAfterReplay, timerAuditCountAfterReplay, sideEffectCountAfterReplay, targetAfterReplay] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId: timerMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.count({ where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } })
    ]);
    expect(timerReceiptCountAfterReplay).toBe(1);
    expect(timerAuditCountAfterReplay).toBe(1);
    expect(sideEffectCountAfterReplay).toBe(sideEffectCountBeforeReplay);
    expect(targetAfterReplay).toEqual(targetAfterDelete);
  });

  it("falls back to the current timer target for a matching legacy receipt without an outcome snapshot", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Legacy Timer Receipt Owner",
        email: "legacy-timer-receipt-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Legacy Timer Receipt Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Legacy Timer Receipt Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Legacy Timer Receipt Baby", timezone: "UTC" }
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        householdId: household.id,
        legacyUnattributed: true,
        name: "Legacy Timer Receipt Webhook",
        url: "https://acceptance.invalid/legacy-timer-receipt",
        secret: "acceptance-legacy-timer-receipt-secret",
        events: [WebhookEvent.timer_stopped]
      }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T14:00:00.000Z"),
        startedAt: new Date("2026-07-31T14:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const clientMutationId = "858d1706-0a45-4b59-a3c5-0aa7eb092b2a";
    const intentFingerprint = createHash("sha256")
      .update(JSON.stringify({ operation: "timer.stop", activityId: activity.id }))
      .digest("hex");
    const legacyReceipt = await prisma.mutationReceipt.create({
      data: {
        householdId: household.id,
        actorMemberId: member.id,
        apiKeyId: null,
        operation: "timer.stop",
        targetActivityId: activity.id,
        clientMutationId,
        intentFingerprint,
        outcomeActivityId: activity.id,
        outcomeSnapshot: Prisma.DbNull
      }
    });
    const targetBeforeReplay = await prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } });
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const replay = await stopTimer(activity.id, { clientMutationId });

    expect(legacyReceipt).toMatchObject({
      householdId: household.id,
      actorMemberId: member.id,
      apiKeyId: null,
      operation: "timer.stop",
      targetActivityId: activity.id,
      clientMutationId,
      intentFingerprint,
      outcomeActivityId: activity.id,
      outcomeSnapshot: null
    });
    expect(replay).toMatchObject({
      id: activity.id,
      timerState: TimerState.running,
      startedAt: targetBeforeReplay.startedAt,
      endedAt: null,
      pausedAt: null,
      pausedSeconds: 0
    });
    expect(replay.updatedAt).toEqual(targetBeforeReplay.updatedAt);

    const [receiptCount, auditCount, webhookCount, targetAfterReplay] = await Promise.all([
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.count({ where: { householdId: household.id, action: "activity.timer.stop", entityId: activity.id } }),
      prisma.webhookDelivery.count({ where: { householdId: household.id, endpointId: endpoint.id, event: WebhookEvent.timer_stopped, activityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } })
    ]);
    expect(receiptCount).toBe(1);
    expect(auditCount).toBe(0);
    expect(webhookCount).toBe(0);
    expect(targetAfterReplay).toEqual(targetBeforeReplay);
  });

  it("rejects a stale activity edit after a pause wins without a losing receipt or duplicate audit effect", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Stale Edit Owner",
        email: "stale-edit-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Stale Edit Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Stale Edit Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Stale Edit Baby", timezone: "UTC" }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T12:00:00.000Z"),
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const winningMutationId = "97a1f509-07d1-4e5c-ae43-1cf334d4b5a7";
    const losingMutationId = "86b1f509-07d1-4e5c-ae43-1cf334d4b5a7";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const paused = await pauseTimer(activity.id, { clientMutationId: winningMutationId });
    expect(paused).toMatchObject({ id: activity.id, timerState: TimerState.paused });

    await expect(updateActivity(activity.id, {
      babyId: baby.id,
      type: "sleep",
      occurredAt: "2026-07-31T12:00:00.000Z",
      startedAt: "2026-07-31T12:00:00.000Z",
      sleepType: "nap",
      location: "Changing table",
      notes: "losing stale edit",
      clientMutationId: losingMutationId,
      expectedUpdatedAt: activity.updatedAt.toISOString()
    })).rejects.toThrow("stale_revision");

    const [winningReceipts, losingReceiptCount, pauseAudits, updateAudits, activityAfterConflict] = await Promise.all([
      prisma.mutationReceipt.findMany({ where: { householdId: household.id, clientMutationId: winningMutationId } }),
      prisma.mutationReceipt.count({ where: { householdId: household.id, clientMutationId: losingMutationId } }),
      prisma.auditEvent.findMany({ where: { householdId: household.id, action: "activity.timer.pause", entityId: activity.id } }),
      prisma.auditEvent.findMany({ where: { householdId: household.id, action: "activity.update", entityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: { sleep: true } })
    ]);
    expect(winningReceipts).toHaveLength(1);
    expect(winningReceipts[0]).toMatchObject({ operation: "timer.pause", targetActivityId: activity.id });
    expect(losingReceiptCount).toBe(0);
    expect(pauseAudits).toHaveLength(1);
    expect(updateAudits).toHaveLength(0);
    expect(activityAfterConflict).toMatchObject({
      id: activity.id,
      timerState: TimerState.paused,
      notes: null,
      sleep: { sleepType: "nap", location: "Crib" }
    });
  });

  it("fails closed when a receipt key from a timer pause is reused for a timer resume", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Timer Receipt Conflict Owner",
        email: "timer-receipt-conflict-owner@acceptance.invalid",
        emailVerified: true
      }
    });
    const household = await prisma.household.create({
      data: { name: "Timer Receipt Conflict Household", createdByUserId: user.id }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: HouseholdRole.owner,
        displayName: "Timer Receipt Conflict Owner"
      }
    });
    const baby = await prisma.baby.create({
      data: { householdId: household.id, name: "Timer Receipt Conflict Baby", timezone: "UTC" }
    });
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-07-31T11:00:00.000Z"),
        startedAt: new Date("2026-07-31T11:00:00.000Z"),
        timezone: "UTC",
        timerState: TimerState.running,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const clientMutationId = "57a1f509-07d1-4e5c-ae43-1cf334d4b5a7";
    auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };

    const paused = await pauseTimer(activity.id, { clientMutationId });
    expect(paused).toMatchObject({ id: activity.id, timerState: TimerState.paused });
    const activityAfterPause = await prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } });

    await expect(resumeTimer(activity.id, { clientMutationId })).rejects.toThrow("idempotency_conflict");

    const [receipts, pauseAudits, resumeAudits, activityAfterConflict] = await Promise.all([
      prisma.mutationReceipt.findMany({ where: { householdId: household.id, clientMutationId } }),
      prisma.auditEvent.findMany({ where: { householdId: household.id, action: "activity.timer.pause", entityId: activity.id } }),
      prisma.auditEvent.findMany({ where: { householdId: household.id, action: "activity.timer.resume", entityId: activity.id } }),
      prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } })
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ operation: "timer.pause", targetActivityId: activity.id });
    expect(pauseAudits).toHaveLength(1);
    expect(resumeAudits).toHaveLength(0);
    expect(activityAfterConflict).toEqual(activityAfterPause);
  });
});
