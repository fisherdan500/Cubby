import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BackupRestoreForm } from "@/components/settings/backup-restore-form";
import { SproutRestoreForm } from "@/components/settings/sprout-restore-form";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requireUserPage } from "@/server/auth/session";
import { listBackupRecords } from "@/server/services/backups";

export default async function BackupsSettingsPage() {
  const user = await requireUserPage();
  const records = await listBackupRecords();

  return (
    <AppShell title="Backups" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <section className="space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-black">Exports</h2>
            <div className="flex flex-wrap gap-3">
              <Link href="/api/backups/export">
                <Button>JSON backup</Button>
              </Link>
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
            <BackupRestoreForm />
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-black">Restore from Sprout Track</h2>
            <SproutRestoreForm />
          </Card>
        </section>
        <Card className="space-y-3">
          <h2 className="text-lg font-black">Backup records</h2>
          {records.length ? null : <p className="text-sm text-muted-foreground">No backup records yet.</p>}
          {records.map((record) => (
            <div key={record.id} className="rounded-md bg-muted p-3">
              <p className="font-black">
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
