import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { SessionManager } from "@/components/settings/session-manager";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";

export default async function SessionsPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Sessions" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <div>
        <Card>
          <SessionManager key={`sessions:${user.id}`} accountScope={user.id} timeZone={env.APP_TIMEZONE} />
        </Card>
      </div>
    </AppShell>
  );
}
