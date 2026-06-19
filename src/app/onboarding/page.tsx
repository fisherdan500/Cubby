import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/forms/onboarding-form";
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
        <div>
          <h1 className="text-2xl font-bold">Set up Cubby</h1>
          <p className="text-sm text-muted-foreground">Create your household and first baby profile.</p>
        </div>
        <OnboardingForm />
      </Card>
    </main>
  );
}
