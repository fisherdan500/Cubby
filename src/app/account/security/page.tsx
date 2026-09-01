import Link from "next/link";
import { AccountSecurityPanel } from "@/components/account-security-panel";
import { SecurityHistory } from "@/components/settings/security-history";
import { SessionManager } from "@/components/settings/session-manager";
import { requireUserPage } from "@/server/auth/session";

export default async function AccountSecurityPage() {
  const user = await requireUserPage();
  return <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-3 py-8 md:px-8"><Link href="/app" className="text-sm font-bold text-primary">Back to Cubby</Link><header><p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Personal account</p><h1 className="font-editorial text-3xl font-bold">Account security</h1><p className="mt-1 text-sm text-muted-foreground">Credentials, recovery, active sessions, and history belong to you—not to a household role.</p></header><AccountSecurityPanel key={`account-security:${user.id}`} accountScope={user.id} /><SessionManager key={`sessions:${user.id}`} accountScope={user.id} /><SecurityHistory key={`history:${user.id}`} accountScope={user.id} headingLevel={2} /></main>;
}
