import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { SessionManager } from "@/components/settings/session-manager";
import { requireUserPage } from "@/server/auth/session";

export default async function SessionsPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Sessions" userName={user.name}>
      <div className="md:pl-56">
        <Card>
          <SessionManager />
        </Card>
      </div>
    </AppShell>
  );
}
