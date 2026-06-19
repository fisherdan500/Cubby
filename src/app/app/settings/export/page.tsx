import { Download } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";

export default async function ExportPage() {
  const user = await requireUserPage();
  return (
    <AppShell title="Export" userName={user.name}>
      <div>
        <Card className="max-w-xl space-y-3">
          <h2 className="text-lg font-bold">Activity CSV</h2>
          <p className="text-sm text-muted-foreground">
            Export household activity data as a CSV file for pediatrician visits or personal backup.
          </p>
          <a href="/api/export/activities.csv">
            <Button>
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
          </a>
        </Card>
      </div>
    </AppShell>
  );
}
