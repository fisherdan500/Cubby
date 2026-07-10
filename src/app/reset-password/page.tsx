import { Card } from "@/components/ui/card";
import { ActivityArtwork } from "@/components/activity-artwork";

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md space-y-3">
        <ActivityArtwork type="note" size="xl" className="mx-auto mb-3" />
        <h1 className="text-center font-editorial text-3xl font-bold">Password reset ready</h1>
        <p className="text-sm text-muted-foreground">
          Cubby is wired for Better Auth password reset callbacks. SMTP delivery is intentionally stubbed in v1 until mail settings are configured.
        </p>
      </Card>
    </main>
  );
}
