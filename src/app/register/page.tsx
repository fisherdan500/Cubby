import Link from "next/link";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default async function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup orientation="vertical" size="lg" priority />
          </Link>
          <h1 className="mt-2 font-editorial text-3xl font-bold">Account creation unavailable</h1>
          <p className="text-sm text-muted-foreground">
            Account creation is temporarily unavailable while Cubby completes its credential-security protocol.
          </p>
        </div>
        <Link href="/login">
          <Button className="w-full">Sign in</Button>
        </Link>
      </Card>
    </main>
  );
}
