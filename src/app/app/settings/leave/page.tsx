import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LeaveHouseholdForm } from "@/components/settings/leave-household-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdLeaveOptions, getHouseholdLeavePreview } from "@/server/services/household-leave";

export default async function LeaveHouseholdPage({
  searchParams
}: {
  searchParams: { householdId?: string };
}) {
  const user = await requireUserPage();
  const options = await getHouseholdLeaveOptions();
  const selectedHouseholdId = searchParams.householdId
    ?? options.find((option) => !option.suspended)?.householdId
    ?? options[0]?.householdId;
  if (!selectedHouseholdId || !options.some((option) => option.householdId === selectedHouseholdId)) notFound();
  const preview = await getHouseholdLeavePreview(selectedHouseholdId);

  return (
    <AppShell title="Leave household" userName={user.name}>
      <div className="mx-auto max-w-2xl">
        {options.length > 1 ? (
          <Card className="mb-4 space-y-2">
            <h2 className="font-bold">Choose a membership</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((option) => (
                <Link
                  key={option.membershipId}
                  href={`/app/settings/leave?householdId=${encodeURIComponent(option.householdId)}`}
                  className={`rounded-lg border p-3 text-sm transition hover:bg-muted ${
                    option.householdId === selectedHouseholdId ? "border-primary bg-primary/5" : "border-border"
                  }`}
                  aria-current={option.householdId === selectedHouseholdId ? "page" : undefined}
                >
                  <span className="block font-semibold">{option.householdName}</span>
                  <span className="text-muted-foreground">
                    {option.suspended ? "Suspended membership" : "Active membership"}
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        ) : null}
        <Card className="space-y-4">
          <div>
            <h1 className="font-editorial text-2xl font-bold">Leave {preview.householdName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Review the consequences and confirm the household name exactly.
            </p>
          </div>
          <LeaveHouseholdForm preview={preview} />
        </Card>
      </div>
    </AppShell>
  );
}
