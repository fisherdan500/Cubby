import { AppShell } from "@/components/app-shell";
import { SecurityHistory } from "@/components/settings/security-history";
import { requireUserPage } from "@/server/auth/session";

export default async function SecurityHistoryPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Security history" userName={user.name}>
      <SecurityHistory />
    </AppShell>
  );
}
