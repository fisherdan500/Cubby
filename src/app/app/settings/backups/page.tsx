import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { AutomatedBackupStatus } from "@/components/settings/automated-backup-status";
import { BackupRestoreForm } from "@/components/settings/backup-restore-form";
import { BackupDownloadButton } from "@/components/settings/backup-download-button";
import { SproutRestoreForm } from "@/components/settings/sprout-restore-form";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { formatInstant } from "@/lib/timezone";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getAutomatedBackupStatus, getBackupRestoreTargetName, listBackupRecords } from "@/server/services/backups";

export default async function BackupsSettingsPage() {
  const { user } = await requireSettingsPage("backup.manage");
  const [records, targetHouseholdName, automatedStatus] = await Promise.all([
    listBackupRecords(),
    getBackupRestoreTargetName(),
    getAutomatedBackupStatus()
  ]);

  return (
    <AppShell title="Backups" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <section className="min-w-0 space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Exports</h2>
            <div className="flex flex-wrap gap-3">
              <BackupDownloadButton />
              <Link href="/api/export/activities.csv">
                <Button variant="secondary">CSV activity export</Button>
              </Link>
              <Link href="/api/export/activities.tsv">
                <Button variant="secondary">Spreadsheet TSV</Button>
              </Link>
            </div>
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Restore</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Download an existing local version below, then upload it here to preview and restore into a fresh owner household.
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              A household backup carries this household&apos;s data, and each member&apos;s name and role so its history stays correctly
              attributed. It deliberately carries no passwords, so anyone without an account on the Cubby you restore into is listed
              for you to invite again.
            </p>
            <BackupRestoreForm targetHouseholdName={targetHouseholdName} timeZone={env.APP_TIMEZONE} />
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Moving to a new server</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              To move a whole Cubby — every household, account and photo, with everyone signing in exactly as before — use a
              whole-system backup. It runs on the server rather than here, because Cubby is stopped while it is made.
            </p>
            <pre className="mb-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">sh scripts/system-backup.sh --maintenance</pre>
            <p className="text-sm text-muted-foreground">
              Keep a copy of the server&apos;s <code>.env</code> somewhere safe of its own: it holds the keys the restored accounts and
              sign-ins depend on, and it is deliberately not inside the archive. Full instructions, including nightly scheduling and
              restoring onto a new server, are in <code>docs/recovery/system-backup.md</code> in the Cubby checkout.
            </p>
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Restore from Sprout Track</h2>
            <SproutRestoreForm />
          </Card>
        </section>
        <Card className="min-w-0 space-y-3">
          <h2 className="text-lg font-semibold">Automated local backups</h2>
          <AutomatedBackupStatus status={automatedStatus} timeZone={env.APP_TIMEZONE} />
        </Card>
        <Card className="min-w-0 space-y-3">
          <h2 className="text-lg font-semibold">Backup records</h2>
          <p className="text-sm text-muted-foreground">Manual export records describe preparation. Download receipt is not confirmed; a later storage or connection failure can interrupt it. Check that the file finished saving.</p>
          {records.length ? null : <p className="text-sm text-muted-foreground">No backup records yet.</p>}
          {records.map((record) => (
            <div key={record.id} className="rounded-md bg-muted p-3">
              <p className="break-words font-semibold">
                {record.kind === "export" && record.status === "complete" ? "Export prepared" : `${record.kind} - ${record.status}`}
              </p>
              <p className="text-sm text-muted-foreground">
                {record.itemCount ?? 0} items - {formatInstant(record.createdAt, env.APP_TIMEZONE)}
              </p>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}
