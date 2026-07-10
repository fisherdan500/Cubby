export const householdRoles = ["owner", "admin", "parent", "caretaker", "read_only"] as const;
export type HouseholdRoleName = (typeof householdRoles)[number];

export const assignableHouseholdRoles = ["admin", "parent", "caretaker", "read_only"] as const;
export type AssignableHouseholdRole = (typeof assignableHouseholdRoles)[number];

export const householdRoleDetails: Record<HouseholdRoleName, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Protected household owner with full administrative access." },
  admin: { label: "Admin", description: "Manages household settings, people, integrations, backups, and activity." },
  parent: { label: "Parent", description: "Manages babies, notifications, exports, and all activity." },
  caretaker: { label: "Caretaker", description: "Logs activity and manages only activity they recorded." },
  read_only: { label: "Read only", description: "Can review household activity without making changes." }
};

export type Permission =
  | "household.manage"
  | "admin.manage"
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
    "admin.manage",
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
  admin: [
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

export function canAssignHouseholdRole(actorRole: HouseholdRoleName, nextRole: AssignableHouseholdRole) {
  if (!hasPermission(actorRole, "member.manage")) return false;
  if (nextRole === "admin") return hasPermission(actorRole, "admin.manage");
  return actorRole === "owner" || actorRole === "admin";
}

export function canManageHouseholdRole(actorRole: HouseholdRoleName, targetRole: HouseholdRoleName) {
  if (!hasPermission(actorRole, "member.manage") || targetRole === "owner") return false;
  if (targetRole === "admin") return hasPermission(actorRole, "admin.manage");
  return actorRole === "owner" || actorRole === "admin";
}

export function canMutateOwnOrAny(
  role: HouseholdRoleName,
  action: "update" | "delete",
  isOwn: boolean
) {
  if (hasPermission(role, `activity.${action}.any` as Permission)) return true;
  return isOwn && hasPermission(role, `activity.${action}.own` as Permission);
}
