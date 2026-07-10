import { redirect } from "next/navigation";
import { hasPermission, type Permission } from "@/domain/roles";
import { getHouseholdContext } from "@/server/auth/context";
import { requireUserPage } from "@/server/auth/session";

export async function requireSettingsPage(permission: Permission) {
  const user = await requireUserPage();
  const ctx = await getHouseholdContext();
  if (!hasPermission(ctx.role, permission)) redirect("/app/settings?denied=1");
  return { user, ctx };
}
