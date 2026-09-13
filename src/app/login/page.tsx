import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { BrandLockup } from "@/components/brand";
import { Card } from "@/components/ui/card";

export default async function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup orientation="vertical" size="lg" priority />
          </Link>
          <h1 className="mt-2 font-editorial text-3xl font-bold">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Sign in once and keep tracking on your own device.</p>
        </div>
        <AuthForm />
        <p className="text-center text-sm text-muted-foreground"><Link href="/recovery" className="font-semibold text-primary underline-offset-4 hover:underline">Use an offline recovery code</Link></p>
      </Card>
    </main>
  );
}
