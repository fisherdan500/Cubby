import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { Card } from "@/components/ui/card";

export default function LoginPage() {
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
        <AuthForm mode="login" />
      </Card>
    </main>
  );
}
