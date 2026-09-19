import { AppShell } from "@/components/app-shell";
import { SecurityHistory } from "@/components/settings/security-history";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";

export default async function SecurityHistoryPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Security history" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <SecurityHistory key={`history:${user.id}`} accountScope={user.id} timeZone={env.APP_TIMEZONE} headingLevel={2} />
    </AppShell>
  );
}
