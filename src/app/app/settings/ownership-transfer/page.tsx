import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  OwnershipTransferAnswerForm,
  OwnershipTransferForm
} from "@/components/settings/ownership-transfer-form";
import { Card } from "@/components/ui/card";
import { env } from "@/lib/env";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdLeaveOptions } from "@/server/services/household-leave";
import { getOwnershipTransferView } from "@/server/services/household-ownership-transfer";

/**
 * Handing a household to someone else.
 *
 * One screen serves both sides: the owner offering, and the member being asked. Which one you see
 * depends on who you are, because a pending transfer is only actionable by its named recipient.
 *
 * Someone can belong to several households and own only one of them, so the membership picker is
 * not a convenience here -- without it, a User who joined another household first would land on a
 * household they cannot transfer with no way to reach the one they own.
 */
export default async function OwnershipTransferPage({
  searchParams
}: {
  searchParams: { householdId?: string };
}) {
  const user = await requireUserPage();
  const memberships = await getHouseholdLeaveOptions();
  if (memberships.length === 0) notFound();

  const views = await Promise.all(
    memberships.map(async (option) => {
      try {
        return await getOwnershipTransferView(option.householdId);
      } catch {
        return null;
      }
    })
  );

  // Land on something actionable: an offer waiting for this person first, then a household they
  // own. Otherwise the picker is the only way out of a household with nothing to do.
  const actionable = views.find((candidate) => candidate?.pending?.awaitingMe)
    ?? views.find((candidate) => candidate?.isOwner);
  const selectedHouseholdId = searchParams.householdId
    ?? actionable?.householdId
    ?? memberships[0]?.householdId;
  if (!selectedHouseholdId || !memberships.some((option) => option.householdId === selectedHouseholdId)) {
    notFound();
  }

  const view = views.find((candidate) => candidate?.householdId === selectedHouseholdId);
  if (!view) notFound();
  const awaitingMe = view.pending?.awaitingMe ? view.pending : null;

  return (
    <AppShell
      title="Household ownership"
      userName={user.name}
      parent={{ href: "/app/settings", label: "Settings" }}
    >
      <div className="mx-auto max-w-2xl">
        {memberships.length > 1 ? (
          <Card className="mb-4 space-y-2">
            <h2 className="font-bold">Choose a household</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {memberships.map((option, index) => {
                const candidate = views[index];
                const label = candidate?.pending?.awaitingMe
                  ? "Offered to you"
                  : candidate?.isOwner
                    ? "You own this"
                    : "Nothing to do";
                return (
                  <Link
                    key={option.membershipId}
                    href={`/app/settings/ownership-transfer?householdId=${encodeURIComponent(option.householdId)}`}
                    className={`rounded-lg border p-3 text-sm transition hover:bg-muted ${
                      option.householdId === selectedHouseholdId ? "border-primary bg-primary/5" : "border-border"
                    }`}
                    aria-current={option.householdId === selectedHouseholdId ? "page" : undefined}
                  >
                    <span className="block font-semibold">{option.householdName}</span>
                    <span className="text-muted-foreground">{label}</span>
                  </Link>
                );
              })}
            </div>
          </Card>
        ) : null}

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
              timeZone={env.APP_TIMEZONE}
            />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="font-semibold">There is nothing for you to do here.</p>
              <p className="text-muted-foreground">
                Only the owner of {view.householdName} can offer it to someone else, and only the
                member they choose can accept. If you are expecting an offer, ask the owner to make
                it and it will appear here.
              </p>
              <Link className="inline-block font-semibold underline" href="/app/settings">
                Back to settings
              </Link>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
