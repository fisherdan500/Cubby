import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { AutomatedBackupStatus } from "@/components/settings/automated-backup-status";
import { BackupRestoreForm } from "@/components/settings/backup-restore-form";
import { BackupDownloadButton } from "@/components/settings/backup-download-button";
import { SproutRestoreForm } from "@/components/settings/sprout-restore-form";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
    <AppShell title="Backups" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <section className="min-w-0 space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-black">Exports</h2>
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
            <h2 className="mb-3 text-lg font-black">Restore</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Download an existing local version below, then upload it here to preview and restore into a fresh owner household.
            </p>
            <BackupRestoreForm targetHouseholdName={targetHouseholdName} />
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-black">Restore from Sprout Track</h2>
            <SproutRestoreForm />
          </Card>
        </section>
        <Card className="min-w-0 space-y-3">
          <h2 className="text-lg font-black">Automated local backups</h2>
          <AutomatedBackupStatus status={automatedStatus} />
        </Card>
        <Card className="min-w-0 space-y-3">
          <h2 className="text-lg font-black">Backup records</h2>
          {records.length ? null : <p className="text-sm text-muted-foreground">No backup records yet.</p>}
          {records.map((record) => (
            <div key={record.id} className="rounded-md bg-muted p-3">
              <p className="break-words font-black">
                {record.kind} - {record.status}
              </p>
              <p className="text-sm text-muted-foreground">
                {record.itemCount ?? 0} items - {record.createdAt.toLocaleString()}
              </p>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}
