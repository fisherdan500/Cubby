import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandLockup } from "@/components/brand";
import { PlatformSetupClaimForm } from "@/components/platform-setup-claim-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { isPlatformOwner } from "@/server/services/platform-authority";
import { getAppRegistrationPolicy } from "@/server/services/registration";

export default async function PlatformSetupPage() {
  const user = await requireUserPage();
  const policy = await getAppRegistrationPolicy();
  if (policy.platformOwnerBound) {
    redirect((await isPlatformOwner(user.id)) ? "/platform/settings" : "/app");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg space-y-5">
        <div className="text-center">
          <BrandLockup orientation="vertical" size="lg" className="mb-3" priority />
          <h1 className="font-editorial text-3xl font-bold">Finish setting up Cubby</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cubby has no platform owner yet. The owner decides who can create accounts and households.
          </p>
        </div>
        <div className="space-y-2 rounded-lg bg-muted p-3 text-sm">
          <p className="font-semibold">Find your one-time code in the server log:</p>
          <pre className="overflow-x-auto rounded-md bg-card px-3 py-2 font-mono text-xs">docker logs cubby-app-1{"\n"}# or, from the Cubby folder:{"\n"}docker compose logs app</pre>
          <p className="text-muted-foreground">
            Look for &ldquo;Cubby has no platform owner yet&rdquo;. The code works once and expires after 24 hours;
            restarting Cubby prints a new one. Only someone who can read the server&apos;s log can claim it.
          </p>
        </div>
        <PlatformSetupClaimForm />
        <p className="text-center text-xs text-muted-foreground">
          Signed in as {user.email}.{" "}
          <Link href="/app" className="font-semibold text-primary">
            Not now
          </Link>
        </p>
      </Card>
    </main>
  );
}
