import { canMutateOwnOrAny, type HouseholdRoleName } from "@/domain/roles";

export type ActivityRowViewer = { memberId: string; role: HouseholdRoleName };
export type ActivityRowActions = { canUpdate: boolean; canDelete: boolean };

/**
 * What a list row's swipe may offer: the same rule the activity's own page applies to its Edit and
 * Delete, so a swipe never shows an action the server would refuse.
 */
export function activityRowActions(viewer: ActivityRowViewer, activity: { actorMemberId: string | null }): ActivityRowActions {
  const isOwn = activity.actorMemberId === viewer.memberId;
  return {
    canUpdate: canMutateOwnOrAny(viewer.role, "update", isOwn),
    canDelete: canMutateOwnOrAny(viewer.role, "delete", isOwn)
  };
}
