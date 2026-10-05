import { z } from "zod";

import { activityLabels, type ActivityTypeName } from "@/domain/activity";

export const ACTIVITY_CREATED_NOTIFICATION_CATEGORY = "activity_created" as const;

/** A deliberately closed, content-free payload for a lock screen. */
export const activityPushPayloadSchema = z.object({
  kind: z.literal(ACTIVITY_CREATED_NOTIFICATION_CATEGORY),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(160),
  url: z.string().url(),
  tag: z.string().min(1).max(100)
}).strict();

/**
 * Lock-screen-safe text for a newly logged activity. The activity's notes and type-specific details
 * never enter this function, so medicine names, note text, and similar household content stay inside
 * Cubby.
 */
export function activityNotificationText(input: {
  actorName: string;
  babyName: string;
  activityType: ActivityTypeName;
}): { title: string; body: string } {
  const actor = input.actorName.trim() || "Someone";
  const baby = input.babyName.trim() || "your baby";
  return {
    title: "New activity",
    body: `${actor} logged ${activityLabels[input.activityType].toLowerCase()} for ${baby}`
  };
}
