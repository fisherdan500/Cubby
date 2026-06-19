export const householdRoles = ["owner", "parent", "caretaker", "read_only"] as const;
export type HouseholdRoleName = (typeof householdRoles)[number];

export type Permission =
  | "household.manage"
  | "member.manage"
  | "baby.manage"
  | "activity.read"
  | "activity.create"
  | "activity.update.any"
  | "activity.update.own"
  | "activity.delete.any"
  | "activity.delete.own"
  | "invite.create"
  | "export.create"
  | "session.manage"
  | "integration.manage"
  | "backup.manage"
  | "notification.manage";

const rolePermissions: Record<HouseholdRoleName, Permission[]> = {
  owner: [
    "household.manage",
    "member.manage",
    "baby.manage",
    "activity.read",
    "activity.create",
    "activity.update.any",
    "activity.delete.any",
    "invite.create",
    "export.create",
    "session.manage",
    "integration.manage",
    "backup.manage",
    "notification.manage"
  ],
  parent: [
    "baby.manage",
    "activity.read",
    "activity.create",
    "activity.update.any",
    "activity.delete.any",
    "invite.create",
    "export.create",
    "session.manage",
    "notification.manage"
  ],
  caretaker: [
    "activity.read",
    "activity.create",
    "activity.update.own",
    "activity.delete.own",
    "session.manage"
  ],
  read_only: ["activity.read", "session.manage"]
};

export function hasPermission(role: HouseholdRoleName, permission: Permission) {
  return rolePermissions[role]?.includes(permission) ?? false;
}

export function canMutateOwnOrAny(
  role: HouseholdRoleName,
  action: "update" | "delete",
  isOwn: boolean
) {
  if (hasPermission(role, `activity.${action}.any` as Permission)) return true;
  return isOwn && hasPermission(role, `activity.${action}.own` as Permission);
}
