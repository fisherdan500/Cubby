import { Card } from "@/components/ui/card";

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-3">
        <h1 className="text-2xl font-bold">Password reset ready</h1>
        <p className="text-sm text-muted-foreground">
          Cubby is wired for Better Auth password reset callbacks. SMTP delivery is intentionally stubbed in v1 until mail settings are configured.
        </p>
      </Card>
    </main>
  );
}
