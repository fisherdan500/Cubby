import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { Card } from "@/components/ui/card";
import { extractInviteToken, getAppRegistrationPolicy } from "@/server/services/registration";
import { getInviteByToken } from "@/server/services/invites";

export default async function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = searchParams.next ?? "/app";
  const inviteToken = extractInviteToken(next);
  const [policy, invite] = await Promise.all([
    getAppRegistrationPolicy(),
    inviteToken ? getInviteByToken(inviteToken) : Promise.resolve(null)
  ]);
  const allowRegisterLink = Boolean(invite) || policy.firstOwnerAllowed || policy.publicRegistrationAllowed;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-5">
        <div>
          <Link href="/" className="text-sm font-semibold text-primary">
            Cubby
          </Link>
          <h1 className="mt-2 text-2xl font-bold">Sign in</h1>
          <p className="text-sm text-muted-foreground">Use your trusted device and keep tracking.</p>
        </div>
        <AuthForm mode="login" next={next} allowRegisterLink={allowRegisterLink} />
      </Card>
    </main>
  );
}
