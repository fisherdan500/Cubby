import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { Card } from "@/components/ui/card";

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-5">
        <div>
          <Link href="/" className="text-sm font-semibold text-primary">
            Cubby
          </Link>
          <h1 className="mt-2 text-2xl font-bold">Create owner account</h1>
          <p className="text-sm text-muted-foreground">You will set up your household and first baby next.</p>
        </div>
        <AuthForm mode="register" />
      </Card>
    </main>
  );
}
