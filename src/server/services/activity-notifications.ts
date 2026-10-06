import { randomUUID } from "node:crypto";
import webpush, { type PushSubscription as WebPushSubscription, type WebPushError } from "web-push";

import {
  ACTIVITY_CREATED_NOTIFICATION_CATEGORY,
  activityNotificationText,
  activityPushPayloadSchema
} from "@/domain/activity-notifications";
import { isActivityType } from "@/domain/activity";
import { prisma } from "@/lib/db/prisma";
import { env, webPushConfig } from "@/lib/env";
import { displayFormatter } from "@/lib/timezone";
import { publicAppUrl } from "@/lib/web-push-config";
import { withinQuietHours } from "@/domain/moment-notifications";
import type { BrowserOperationResult } from "@/server/services/browser-operations";
import { WEB_PUSH_REQUEST_OPTIONS } from "@/server/services/web-push-delivery";

export type ActivityNotificationEvent = {
  householdId: string;
  activityId: string;
};

let configured = false;
function ensureConfigured(): boolean {
  if (!webPushConfig.enabled) return false;
  if (!configured) {
    webpush.setVapidDetails(webPushConfig.subject, webPushConfig.publicKey, webPushConfig.privateKey);
    configured = true;
  }
  return true;
}

/** Deliver the pending, explicitly opted-in notification logs for one newly committed activity. */
export async function sendActivityNotification(
  event: ActivityNotificationEvent
): Promise<{ sent: number; pruned: number; skipped: string }> {
  // Claim before any external work. A terminal browser-operation replay may queue this sender again,
  // and two app instances may race; only one invocation may turn a pending log into a push.
  const claimToken = `delivery_claimed:${randomUUID()}`;
  const claim = await prisma.notificationLog.updateMany({
    where: {
      householdId: event.householdId,
      activityId: event.activityId,
      kind: ACTIVITY_CREATED_NOTIFICATION_CATEGORY,
      status: "pending",
      userId: { not: null }
    },
    data: { status: "failed", error: claimToken, sentAt: null }
  });
  if (claim.count === 0) return { sent: 0, pruned: 0, skipped: "no_pending_logs" };

  const logs = await prisma.notificationLog.findMany({
    where: {
      householdId: event.householdId,
      activityId: event.activityId,
      kind: ACTIVITY_CREATED_NOTIFICATION_CATEGORY,
      status: "failed",
      error: claimToken,
      userId: { not: null }
    },
    select: { id: true, userId: true }
  });
  const logIds = logs.map((log) => log.id);
  const finalizeFailed = async (ids: string[], error: string) => {
    if (ids.length === 0) return;
    await prisma.notificationLog.updateMany({
      where: {
        id: { in: ids },
        householdId: event.householdId,
        activityId: event.activityId,
        status: "failed",
        error: claimToken
      },
      data: { status: "failed", sentAt: null, error }
    });
  };
  if (logs.length === 0) return { sent: 0, pruned: 0, skipped: "claim_lost" };

  if (!ensureConfigured()) {
    await finalizeFailed(logIds, "push_disabled");
    return { sent: 0, pruned: 0, skipped: "push_disabled" };
  }

  const activity = await prisma.activityLog.findFirst({
    where: { id: event.activityId, householdId: event.householdId, deletedAt: null },
    select: {
      id: true,
      babyId: true,
      type: true,
      actorMember: { select: { displayName: true, user: { select: { name: true } } } },
      baby: { select: { name: true } }
    }
  });
  if (!activity || !isActivityType(activity.type)) {
    await finalizeFailed(logIds, "activity_gone");
    return { sent: 0, pruned: 0, skipped: "activity_gone" };
  }
  const userIds = [...new Set(logs.map((log) => log.userId).filter((userId): userId is string => userId !== null))];
  if (userIds.length === 0) {
    await finalizeFailed(logIds, "no_recipients");
    return { sent: 0, pruned: 0, skipped: "no_recipients" };
  }

  // Re-check consent and membership at send time. The transaction that wrote the log did this too,
  // but a member may turn delivery off or leave before this fire-and-forget send begins.
  const preferences = await prisma.notificationPreference.findMany({
    where: {
      householdId: event.householdId,
      status: "active",
      externalDeliveryEnabled: true,
      categories: { has: ACTIVITY_CREATED_NOTIFICATION_CATEGORY },
      channels: { has: "browser_push" },
      OR: [
        { babyScope: "all" },
        { babyScope: "selected", selectedBabies: { some: { babyId: activity.babyId } } }
      ],
      member: {
        is: {
          householdId: event.householdId,
          userId: { in: userIds },
          disabledAt: null,
          deletedAt: null
        }
      }
    },
    select: {
      quietHoursStart: true,
      quietHoursEnd: true,
      member: { select: { userId: true } }
    }
  });
  const nowHHMM = displayFormatter("clock24", env.APP_TIMEZONE).format(new Date());
  const permittedUserIds = new Set(preferences.map((preference) => preference.member.userId));
  const quietUserIds = new Set(
    preferences
      .filter((preference) => withinQuietHours(nowHHMM, preference.quietHoursStart, preference.quietHoursEnd))
      .map((preference) => preference.member.userId)
  );
  const eligibleUserIds = new Set(
    preferences
      .filter((preference) => !withinQuietHours(nowHHMM, preference.quietHoursStart, preference.quietHoursEnd))
      .map((preference) => preference.member.userId)
  );
  await finalizeFailed(
    logs.filter((log) => log.userId === null || !permittedUserIds.has(log.userId)).map((log) => log.id),
    "not_eligible"
  );
  await finalizeFailed(
    logs.filter((log) => log.userId !== null && quietUserIds.has(log.userId)).map((log) => log.id),
    "quiet_hours"
  );
  if (eligibleUserIds.size === 0) return { sent: 0, pruned: 0, skipped: "no_recipients" };

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      householdId: event.householdId,
      userId: { in: [...eligibleUserIds] },
      deletedAt: null
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true, userId: true }
  });
  const subscribedUserIds = new Set(subscriptions.map((subscription) => subscription.userId));
  await finalizeFailed(
    logs
      .filter((log) => log.userId !== null && eligibleUserIds.has(log.userId) && !subscribedUserIds.has(log.userId))
      .map((log) => log.id),
    "no_subscription"
  );
  if (subscriptions.length === 0) return { sent: 0, pruned: 0, skipped: "no_subscriptions" };

  const text = activityNotificationText({
    actorName: activity.actorMember.displayName ?? activity.actorMember.user.name ?? "Someone",
    babyName: activity.baby.name,
    activityType: activity.type
  });
  const payload = activityPushPayloadSchema.parse({
    kind: ACTIVITY_CREATED_NOTIFICATION_CATEGORY,
    title: text.title,
    body: text.body.slice(0, 160),
    url: publicAppUrl(webPushConfig.enabled ? webPushConfig.publicUrl : "", `/app/activities/${encodeURIComponent(activity.id)}`),
    tag: `activity:${activity.id}`
  });

  let sent = 0;
  let pruned = 0;
  const dead: string[] = [];
  const deliveredUserIds = new Set<string>();

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const target: WebPushSubscription = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      };
      try {
        await webpush.sendNotification(target, JSON.stringify(payload), WEB_PUSH_REQUEST_OPTIONS);
        deliveredUserIds.add(subscription.userId);
        sent += 1;
      } catch (error) {
        const status = (error as WebPushError)?.statusCode;
        if (status === 404 || status === 410) dead.push(subscription.id);
      }
    })
  );

  if (dead.length > 0) {
    const result = await prisma.pushSubscription.updateMany({
      where: { id: { in: dead }, householdId: event.householdId, deletedAt: null },
      data: { deletedAt: new Date() }
    });
    pruned = result.count;
  }

  const deliveredLogIds = logs
    .filter((log) => log.userId !== null && deliveredUserIds.has(log.userId))
    .map((log) => log.id);
  if (deliveredLogIds.length > 0) {
    await prisma.notificationLog.updateMany({
      where: {
        id: { in: deliveredLogIds },
        householdId: event.householdId,
        activityId: event.activityId,
        status: "failed",
        error: claimToken
      },
      data: { status: "delivered", sentAt: new Date(), error: null }
    });
  }
  await finalizeFailed(
    logs
      .filter((log) =>
        log.userId !== null &&
        subscribedUserIds.has(log.userId) &&
        !deliveredUserIds.has(log.userId)
      )
      .map((log) => log.id),
    "push_failed"
  );

  return { sent, pruned, skipped: "" };
}

/** Fire and forget only after the activity transaction has committed. */
export function queueActivityNotification(event: ActivityNotificationEvent): void {
  void sendActivityNotification(event).catch(() => undefined);
}

/** Reconcile a durable terminal create after an ambiguous browser response or retained-operation GET. */
export function queueActivityNotificationFromBrowserOperationResult(input: {
  householdId: string;
  result: BrowserOperationResult;
}): void {
  if (input.result.status !== "completed") return;
  const outcome = input.result.outcome;
  if (
    outcome.kind !== "activity" ||
    outcome.action !== "create" ||
    typeof outcome.activityId !== "string" ||
    outcome.activityId.length === 0
  ) return;
  queueActivityNotification({ householdId: input.householdId, activityId: outcome.activityId });
}
