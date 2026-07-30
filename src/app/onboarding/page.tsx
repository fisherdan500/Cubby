import { redirect } from "next/navigation";
import Link from "next/link";
import { OnboardingForm } from "@/components/forms/onboarding-form";
import { BrandLockup } from "@/components/brand";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdLeaveOptions } from "@/server/services/household-leave";
import { getHouseholdHome } from "@/server/services/households";
import { isPlatformOwner } from "@/server/services/platform-authority";
import { getAppRegistrationPolicy } from "@/server/services/registration";

export default async function OnboardingPage() {
  const user = await requireUserPage();
  const [home, leaveOptions] = await Promise.all([
    getHouseholdHome(user.id),
    getHouseholdLeaveOptions()
  ]);
  if (home) redirect("/app");
  const suspendedLeaveOption = leaveOptions.find((option) => option.suspended && option.role !== "owner");
  if (suspendedLeaveOption) {
    redirect(`/app/settings/leave?householdId=${encodeURIComponent(suspendedLeaveOption.householdId)}`);
  }
  const [policy, platformOwner] = await Promise.all([
    getAppRegistrationPolicy(),
    isPlatformOwner(user.id)
  ]);
  const canCreateHousehold = user.emailVerified && policy.newHouseholdCreationAllowed;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg space-y-5">
        <div className="text-center">
          <BrandLockup orientation="vertical" size="lg" className="mb-3" priority />
          <h1 className="font-editorial text-3xl font-bold">Set up Cubby</h1>
          <p className="text-sm text-muted-foreground">
            {!user.emailVerified
              ? "Verify your email before creating a household."
              : policy.newHouseholdCreationAllowed
                ? "Create your household and first baby profile."
                : "Household creation is currently closed."}
          </p>
        </div>
        {platformOwner ? (
          <Link
            href="/platform/settings"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Open platform settings
          </Link>
        ) : null}
        {canCreateHousehold ? (
          <OnboardingForm />
        ) : (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
            {!user.emailVerified
              ? "Your email address must be verified before you can create a household."
              : "A platform owner must open household creation, or you can join through an existing household invitation."}
          </p>
        )}
      </Card>
    </main>
  );
}
