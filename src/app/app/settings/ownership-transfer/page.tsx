import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  OwnershipTransferAnswerForm,
  OwnershipTransferForm
} from "@/components/settings/ownership-transfer-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdLeaveOptions } from "@/server/services/household-leave";
import { getOwnershipTransferView } from "@/server/services/household-ownership-transfer";

/**
 * Handing a household to someone else.
 *
 * One screen serves both sides: the owner offering, and the member being asked. Which one you see
 * depends on who you are, because a pending transfer is only actionable by its named recipient.
 */
export default async function OwnershipTransferPage({
  searchParams
}: {
  searchParams: { householdId?: string };
}) {
  const user = await requireUserPage();
  const memberships = await getHouseholdLeaveOptions();
  const selectedHouseholdId = searchParams.householdId ?? memberships[0]?.householdId;
  if (!selectedHouseholdId || !memberships.some((option) => option.householdId === selectedHouseholdId)) {
    notFound();
  }

  const view = await getOwnershipTransferView(selectedHouseholdId);
  const awaitingMe = view.pending?.awaitingMe ? view.pending : null;

  return (
    <AppShell
      title="Household ownership"
      userName={user.name}
      parent={{ href: "/app/settings", label: "Settings" }}
    >
      <div className="mx-auto max-w-2xl">
        <Card className="space-y-4">
          <div>
            <h1 className="font-editorial text-2xl font-bold">
              {awaitingMe ? `Ownership of ${view.householdName}` : `Transfer ${view.householdName}`}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {awaitingMe
                ? "Someone has offered you this household."
                : "A household has exactly one owner. Ownership moves only when the person receiving it accepts."}
            </p>
          </div>

          {awaitingMe ? (
            <OwnershipTransferAnswerForm
              householdId={view.householdId}
              householdName={view.householdName}
              transferId={awaitingMe.transferId}
              offeredBy={awaitingMe.offeredBy}
            />
          ) : view.isOwner ? (
            <OwnershipTransferForm
              householdId={view.householdId}
              householdName={view.householdName}
              recipients={view.recipients}
              pending={view.pending}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the household owner can transfer ownership.
            </p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
