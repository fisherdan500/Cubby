import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/forms/onboarding-form";
import { BrandLockup } from "@/components/brand";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdHome } from "@/server/services/households";

export default async function OnboardingPage() {
  const user = await requireUserPage();
  const home = await getHouseholdHome(user.id);
  if (home) redirect("/app");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg space-y-5">
        <div className="text-center">
          <BrandLockup orientation="vertical" size="lg" className="mb-3" priority />
          <h1 className="font-editorial text-3xl font-bold">Set up Cubby</h1>
          <p className="text-sm text-muted-foreground">Create your household and first baby profile.</p>
        </div>
        <OnboardingForm />
      </Card>
    </main>
  );
}
