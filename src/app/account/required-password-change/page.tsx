import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { BrandMark } from "@/components/brand";
import { RequiredPasswordChangeForm } from "@/components/account/required-password-change-form";
import { getSession } from "@/server/auth/session";
import { hasOutstandingRequiredChange } from "@/server/services/assisted-required-change-state";

export const dynamic = "force-dynamic";

/**
 * Deliberately outside `/app` so a restricted identity never enters the gated subtree, and
 * reached directly rather than through `requireUserPage`, which redirects restricted identities
 * here.
 */
export default async function RequiredPasswordChangePage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  if (!(await hasOutstandingRequiredChange(session.user.id))) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-10">
      <BrandMark size="lg" />
      <Card className="space-y-4">
        <div className="space-y-2">
          <h1 className="font-editorial text-2xl font-bold">Choose your own password</h1>
          <p className="text-sm text-muted-foreground">
            Your account was set up with a temporary password. Choose a password only you know before
            you continue.
          </p>
        </div>
        <RequiredPasswordChangeForm />
      </Card>
    </main>
  );
}
