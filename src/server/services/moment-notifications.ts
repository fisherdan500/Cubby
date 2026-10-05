import webpush, { type PushSubscription as WebPushSubscription, type WebPushError } from "web-push";

import {
  MOMENT_NOTIFICATION_CATEGORY,
  momentNotificationAudience,
  momentNotificationText,
  momentPushPayloadSchema,
  withinQuietHours,
  type MomentNotificationKind
} from "@/domain/moment-notifications";
import { prisma } from "@/lib/db/prisma";
import { env, webPushConfig } from "@/lib/env";
import { publicAppUrl } from "@/lib/web-push-config";
import { displayFormatter } from "@/lib/timezone";

/**
 * Sending a moment notification.
 *
 * Every send runs AFTER the writing transaction has committed. A push service is a third party
 * that can be slow or unreachable, and nothing it does may roll back a post a caregiver just
 * wrote - the notification is an extra, never a condition of recording the moment. For the same
 * reason every failure here is swallowed: the post stands whether or not a phone hears about it.
 *
 * A subscription the push service reports as gone (404 or 410) is retired immediately. These
 * records accumulate every time someone reinstalls the app or clears their browser, and a dead
 * endpoint retried forever is how a push sender gets rate limited.
 */

const MOMENTS_PATH = "/app/moments";

export type MomentNotificationEvent = {
  householdId: string;
  kind: MomentNotificationKind;
  actorMemberId: string;
  /**
   * The post's author, or for a comment/reaction on a logged entry, whoever recorded it. Null when
   * the parent was written by someone outside the household. Omitted for a comment or reaction, so
   * that the lookup happens inside the send rather than on a request path whose write has already
   * committed - a transient failure there would report a saved comment as a failure.
   */
  parentAuthorMemberId?: string | null;
  /** The post this concerns, for the click target and for collapsing repeats on the phone. */
  postId?: string | null;
  activityId?: string | null;
  babyId?: string | null;
};

/**
 * Whose moment this is. A post carries its author; a logged entry has none, so whoever recorded it
 * stands in, and commenting on a sleep entry reaches the caregiver who logged the sleep.
 */
async function resolveParentAuthor(event: MomentNotificationEvent): Promise<string | null> {
  if (event.parentAuthorMemberId !== undefined) return event.parentAuthorMemberId;
  if (event.postId) {
    const post = await prisma.feedPost.findFirst({
      where: { id: event.postId, householdId: event.householdId, deletedAt: null },
      select: { authorMemberId: true }
    });
    return post?.authorMemberId ?? null;
  }
  if (event.activityId) {
    const activity = await prisma.activityLog.findFirst({
      where: { id: event.activityId, householdId: event.householdId, deletedAt: null },
      select: { actorMemberId: true }
    });
    return activity?.actorMemberId ?? null;
  }
  return null;
}

let configured = false;
function ensureConfigured(): boolean {
  if (!webPushConfig.enabled) return false;
  if (!configured) {
    webpush.setVapidDetails(webPushConfig.subject, webPushConfig.publicKey, webPushConfig.privateKey);
    configured = true;
  }
  return true;
}

/** The members who should hear about this event, after their own preferences are applied. */
export async function momentNotificationRecipients(
  event: MomentNotificationEvent,
  parentAuthorMemberId?: string | null
): Promise<string[]> {
  const parentAuthor = parentAuthorMemberId !== undefined ? parentAuthorMemberId : await resolveParentAuthor(event);
  const [members, priorCommenters] = await Promise.all([
    prisma.householdMember.findMany({
      // disabledAt is this schema's suspension: a suspended member keeps no claim on notifications.
      where: { householdId: event.householdId, deletedAt: null, disabledAt: null },
      select: { id: true }
    }),
    event.kind === "comment"
      ? prisma.feedComment.findMany({
          where: {
            householdId: event.householdId,
            deletedAt: null,
            ...(event.postId ? { postId: event.postId } : {}),
            ...(event.activityId ? { activityId: event.activityId } : {})
          },
          select: { authorMemberId: true }
        })
      : Promise.resolve([])
  ]);

  const audience = momentNotificationAudience({
    kind: event.kind,
    actorMemberId: event.actorMemberId,
    parentAuthorMemberId: parentAuthor,
    priorCommenterMemberIds: priorCommenters
      .map((comment) => comment.authorMemberId)
      .filter((id): id is string => id !== null),
    householdMemberIds: members.map((member) => member.id)
  });
  if (audience.length === 0) return [];

  // The same recipient contract the rest of the app uses (see activities.ts): the preference must
  // be active rather than awaiting re-confirmation, external delivery on, this category chosen,
  // and browser push chosen as a channel. Membership of a category is a POSITIVE test - an empty
  // list means nothing was chosen, so nothing is sent. A member who has not asked for moment
  // notifications must never receive one on a lock screen.
  const preferences = await prisma.notificationPreference.findMany({
    where: {
      householdId: event.householdId,
      memberId: { in: audience },
      status: "active",
      externalDeliveryEnabled: true,
      categories: { has: MOMENT_NOTIFICATION_CATEGORY },
      channels: { has: "browser_push" }
    },
    select: {
      memberId: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      babyScope: true,
      selectedBabies: { select: { babyId: true } }
    }
  });

  // Quiet hours are wall-clock times the member typed, so "now" has to be the household's clock
  // rather than the server's.
  const nowHHMM = displayFormatter("clock24", env.APP_TIMEZONE).format(new Date());

  const allowed: string[] = [];
  for (const memberId of audience) {
    const preference = preferences.find((row) => row.memberId === memberId);
    // No row, or a row the query above rejected, means this member has not opted in.
    if (!preference) continue;
    if (withinQuietHours(nowHHMM, preference.quietHoursStart, preference.quietHoursEnd)) continue;
    // A member watching only some babies does not hear about the others. A post about the whole
    // family carries no baby and reaches everyone who is opted in.
    if (event.babyId && preference.babyScope === "selected") {
      if (!preference.selectedBabies.some((row) => row.babyId === event.babyId)) continue;
    }
    allowed.push(memberId);
  }
  return allowed;
}

/**
 * Deliver one moment event. Returns a content-free count for logging and tests: how many phones
 * were reached, and how many dead subscriptions were retired.
 */
export async function sendMomentNotification(
  event: MomentNotificationEvent
): Promise<{ sent: number; pruned: number; skipped: string }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0, skipped: webPushConfig.enabled ? "" : "push_disabled" };

  // Resolved here, inside the fire-and-forget boundary, so a transient database failure cannot
  // reach a request whose comment or reaction has already been saved.
  const parentAuthor = await resolveParentAuthor(event);
  const recipients = await momentNotificationRecipients(event, parentAuthor);
  if (recipients.length === 0) return { sent: 0, pruned: 0, skipped: "no_recipients" };

  const [actor, baby, subscriptions] = await Promise.all([
    prisma.householdMember.findFirst({
      where: { id: event.actorMemberId, householdId: event.householdId },
      // The same fallback the feed itself uses, so a notification names someone the way the post does.
      select: { displayName: true, user: { select: { name: true } } }
    }),
    event.babyId
      ? prisma.baby.findFirst({ where: { id: event.babyId, householdId: event.householdId }, select: { name: true } })
      : Promise.resolve(null),
    prisma.pushSubscription.findMany({
      where: {
        householdId: event.householdId,
        deletedAt: null,
        user: { memberships: { some: { id: { in: recipients }, householdId: event.householdId } } }
      },
      select: { id: true, endpoint: true, p256dh: true, auth: true, userId: true }
    })
  ]);
  if (subscriptions.length === 0) return { sent: 0, pruned: 0, skipped: "no_subscriptions" };

  // Which member each subscription belongs to, so the right wording reaches the right phone.
  const memberships = await prisma.householdMember.findMany({
    where: { householdId: event.householdId, id: { in: recipients } },
    select: { id: true, userId: true }
  });

  const url = publicAppUrl(
    webPushConfig.enabled ? webPushConfig.publicUrl : "",
    event.postId ? `${MOMENTS_PATH}?post=${encodeURIComponent(event.postId)}` : MOMENTS_PATH
  );
  const tag = `moment:${event.kind}:${event.postId ?? event.activityId ?? "household"}`;

  let sent = 0;
  let pruned = 0;
  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const member = memberships.find((row) => row.userId === subscription.userId);
      if (!member) return;
      const text = momentNotificationText({
        kind: event.kind,
        actorName: actor?.displayName ?? actor?.user.name ?? "Someone",
        recipientIsParentAuthor: member.id === parentAuthor,
        babyName: baby?.name ?? null
      });
      const payload = momentPushPayloadSchema.parse({
        kind: event.kind,
        title: text.title,
        body: text.body.slice(0, 160),
        url,
        tag
      });
      const target: WebPushSubscription = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      };
      try {
        await webpush.sendNotification(target, JSON.stringify(payload));
        sent += 1;
      } catch (error) {
        const status = (error as WebPushError)?.statusCode;
        // 404/410: the browser threw this subscription away. Anything else - a timeout, a 5xx -
        // may well work next time, so the record stays.
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

  return { sent, pruned, skipped: "" };
}

/**
 * Fire and forget, for use after a transaction commits. A rejected promise here must never reach
 * the caller: the moment is already saved, and a push failure is not the caregiver's problem.
 */
export function queueMomentNotification(event: MomentNotificationEvent): void {
  void sendMomentNotification(event).catch(() => undefined);
}
