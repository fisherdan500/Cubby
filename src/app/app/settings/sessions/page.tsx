import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { SessionManager } from "@/components/settings/session-manager";
import { requireSettingsPage } from "@/server/auth/page-access";

export default async function SessionsPage() {
  const { user } = await requireSettingsPage("session.manage");
  return (
    <AppShell title="Sessions" userName={user.name}>
      <div>
        <Card>
          <SessionManager />
        </Card>
      </div>
    </AppShell>
  );
}
