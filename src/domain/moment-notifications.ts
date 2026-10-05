import { z } from "zod";

/**
 * Who hears about what happens in Moments.
 *
 * A post is household news, so everyone but its author hears about it. A comment is a
 * conversation, so the people already in that conversation hear about it - the post's author plus
 * anyone who has commented before - and never the person who just typed it. A reaction is
 * acknowledgement rather than conversation: only the author hears it, or nobody when the author is
 * the one reacting. Notifying every member on every ❤️ would train a household to ignore the
 * notifications that matter.
 *
 * A comment or reaction can hang off a logged entry instead of a post (FeedComment.activityId),
 * and an entry has no author - it has whoever recorded it. That person stands in as the author, so
 * commenting on a sleep entry reaches the caregiver who logged the sleep.
 */

export const MOMENT_NOTIFICATION_KINDS = ["post", "comment", "reaction"] as const;
export type MomentNotificationKind = (typeof MOMENT_NOTIFICATION_KINDS)[number];

/** The notification category a member can switch off. Stored in NotificationPreference.categories. */
export const MOMENT_NOTIFICATION_CATEGORY = "moments" as const;

export type MomentAudienceInput = {
  kind: MomentNotificationKind;
  /** The member who just acted. Never notified about their own action. */
  actorMemberId: string;
  /**
   * The post's author, or for a comment/reaction on a logged entry, whoever recorded it. Null when
   * the parent was written by someone outside the household (an imported or external author).
   */
  parentAuthorMemberId: string | null;
  /** Members who have already commented on this parent, in any order, duplicates allowed. */
  priorCommenterMemberIds?: string[];
  /** Every current member of the household, including the actor. */
  householdMemberIds: string[];
};

/**
 * The members to notify, deduplicated, with the actor removed. Order is stable for tests: the
 * parent author first where they qualify, then prior commenters, then remaining members.
 */
export function momentNotificationAudience(input: MomentAudienceInput): string[] {
  const audience: string[] = [];
  const add = (memberId: string | null | undefined) => {
    if (!memberId) return;
    if (memberId === input.actorMemberId) return;
    // Someone who has left the household keeps no claim on its notifications.
    if (!input.householdMemberIds.includes(memberId)) return;
    if (audience.includes(memberId)) return;
    audience.push(memberId);
  };

  if (input.kind === "post") {
    for (const memberId of input.householdMemberIds) add(memberId);
    return audience;
  }

  if (input.kind === "reaction") {
    add(input.parentAuthorMemberId);
    return audience;
  }

  // A comment reaches the conversation: the author, then everyone who has already replied.
  add(input.parentAuthorMemberId);
  for (const memberId of input.priorCommenterMemberIds ?? []) add(memberId);
  return audience;
}

/**
 * What a phone shows on a locked screen. Names what happened and who did it, never the words they
 * wrote: a lock screen is readable by whoever is holding the phone, and the audit for these same
 * events deliberately records that a post happened rather than its text. The body of a post, a
 * comment, and a photo caption stay inside the application.
 */
export function momentNotificationText(input: {
  kind: MomentNotificationKind;
  actorName: string;
  /** True when the recipient is the author of the post or entry being acted on. */
  recipientIsParentAuthor: boolean;
  babyName?: string | null;
}): { title: string; body: string } {
  const actor = input.actorName.trim() || "Someone";
  if (input.kind === "post") {
    const about = input.babyName?.trim();
    return {
      title: "New moment",
      body: about ? `${actor} posted a moment about ${about}` : `${actor} posted a moment`
    };
  }
  if (input.kind === "reaction") {
    return { title: "New reaction", body: `${actor} reacted to your moment` };
  }
  return {
    title: "New comment",
    body: input.recipientIsParentAuthor ? `${actor} commented on your moment` : `${actor} also commented`
  };
}

/**
 * Quiet hours as the member wrote them: "22:00" to "07:00" wraps past midnight, so the comparison
 * cannot assume start <= end. Equal values mean a full day of quiet rather than none, because a
 * member who sets both ends the same has asked for silence, not for a no-op.
 */
export function withinQuietHours(nowHHMM: string, start?: string | null, end?: string | null): boolean {
  if (!start || !end) return false;
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return false;
  if (!/^\d{2}:\d{2}$/.test(nowHHMM)) return false;
  if (start === end) return true;
  if (start < end) return nowHHMM >= start && nowHHMM < end;
  return nowHHMM >= start || nowHHMM < end;
}

/** The payload the service worker receives. Kept small: push services cap the encrypted body. */
export const momentPushPayloadSchema = z.object({
  kind: z.enum(MOMENT_NOTIFICATION_KINDS),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(160),
  /** Absolute, because a notification click opens it outside any page context. */
  url: z.string().url(),
  /** Collapses repeat notifications about the same thing into one on the phone. */
  tag: z.string().min(1).max(100)
});

export type MomentPushPayload = z.infer<typeof momentPushPayloadSchema>;
