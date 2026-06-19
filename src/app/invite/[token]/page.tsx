import Link from "next/link";
import { AcceptInviteButton } from "@/components/actions/accept-invite-button";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getSession } from "@/server/auth/session";
import { getInviteByToken } from "@/server/services/invites";

export default async function InvitePage({ params }: { params: { token: string } }) {
  const [invite, session] = await Promise.all([getInviteByToken(params.token), getSession()]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-4">
        {!invite ? (
          <>
            <h1 className="text-2xl font-bold">Invite unavailable</h1>
            <p className="text-sm text-muted-foreground">This invite is expired, revoked, or no longer exists.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold">Join {invite.household.name}</h1>
            <p className="text-sm text-muted-foreground">
              You were invited as {invite.role}. Sign in or create an account, then accept the invite.
            </p>
            {session?.user ? (
              <AcceptInviteButton token={params.token} />
            ) : (
              <div className="flex gap-3">
                <Link href={`/login?next=/invite/${params.token}`}>
                  <Button>Sign in</Button>
                </Link>
                <Link href={`/register?next=/invite/${params.token}`}>
                  <Button variant="secondary">Create account</Button>
                </Link>
              </div>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
