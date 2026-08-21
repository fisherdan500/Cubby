import Link from "next/link";
import { BrowserOperationRecovery } from "@/components/browser-operation-recovery";
import { PersonalAppearanceForm } from "@/components/personal-appearance-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getAccountAppearance } from "@/server/services/account-appearance";

export default async function AccountAppearancePage() {
  const user = await requireUserPage();
  const appearance = await getAccountAppearance();
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-3 py-8 md:px-8">
      <Link href="/app/settings/appearance" className="text-sm font-bold text-primary">Back to Cubby</Link>
      <BrowserOperationRecovery />
      <Card className="mt-4">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Personal account</p>
        <h1 className="font-editorial text-2xl font-semibold">Personal appearance</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          This setting follows {user.name} across authorized devices and never changes a household or another user&apos;s view.
        </p>
        <PersonalAppearanceForm
          initialMode={appearance.appearanceMode}
          initialRevision={appearance.appearanceRevision}
        />
      </Card>
    </main>
  );
}
