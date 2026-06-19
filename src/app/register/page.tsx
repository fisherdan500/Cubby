import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { extractInviteToken, getAppRegistrationPolicy } from "@/server/services/registration";
import { getInviteByToken } from "@/server/services/invites";

export default async function RegisterPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = searchParams.next ?? "/onboarding";
  const inviteToken = extractInviteToken(next);
  const [policy, invite] = await Promise.all([
    getAppRegistrationPolicy(),
    inviteToken ? getInviteByToken(inviteToken) : Promise.resolve(null)
  ]);
  const allowed = Boolean(invite) || policy.firstOwnerAllowed || policy.publicRegistrationAllowed;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-5">
        <div>
          <Link href="/" className="text-sm font-semibold text-primary">
            Cubby
          </Link>
          <h1 className="mt-2 text-2xl font-bold">{invite ? `Join ${invite.household.name}` : "Create owner account"}</h1>
          <p className="text-sm text-muted-foreground">
            {invite
              ? `This invite will add you as ${invite.role}.`
              : policy.firstOwnerAllowed
                ? "You will set up your household and first baby next."
                : "Public account creation is controlled by the household owner."}
          </p>
        </div>
        {allowed ? (
          <AuthForm mode="register" next={next} inviteToken={inviteToken} />
        ) : (
          <div className="space-y-3">
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              Account creation is invite-only. Ask the household owner to send you an invite link.
            </p>
            <Link href="/login">
              <Button className="w-full">Sign in</Button>
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
