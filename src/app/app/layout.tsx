import { HouseholdSelectionControl } from "@/components/household-selection-control";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdSelectionState } from "@/server/services/household-selection";

export default async function AuthenticatedAppLayout({ children }: { children: React.ReactNode }) {
  await requireUserPage();
  const selection = await getHouseholdSelectionState();
  const accentTheme = selection.selected?.accentTheme ?? "sage";
  return (
    <div data-accent={accentTheme}>
      <HouseholdSelectionControl state={selection} />
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
