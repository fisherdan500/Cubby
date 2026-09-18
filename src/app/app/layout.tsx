import { HouseholdSelectionControl } from "@/components/household-selection-control";
import { SessionActivityReporter } from "@/components/session-activity-reporter";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdSelectionState } from "@/server/services/household-selection";
import { requireInvitationSetupCorridor } from "@/server/services/invitation-setup-corridor";

export default async function AuthenticatedAppLayout({ children }: { children: React.ReactNode }) {
  await requireUserPage();
  await requireInvitationSetupCorridor("membership");
  const selection = await getHouseholdSelectionState();
  const accentTheme = selection.selected?.accentTheme ?? "sage";
  // The switcher is only useful when there is something to switch to, or when a choice is still
  // required. With one household already selected it was a full-width block above every screen -
  // the largest single thing between a parent and the day's log.
  const showHouseholdSelection = selection.status !== "selected" || selection.options.length > 1;
  return (
    <div data-accent={accentTheme}>
      <SessionActivityReporter />
      {showHouseholdSelection ? <HouseholdSelectionControl state={selection} /> : null}
      {selection.status === "selected" ? children : (
        <main className="mx-auto max-w-2xl px-3 py-8 md:px-8">
          <h1 className="font-editorial text-2xl font-bold">Choose your household</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Household access is established only after you explicitly select a current membership.
          </p>
        </main>
      )}
    </div>
  );
}
