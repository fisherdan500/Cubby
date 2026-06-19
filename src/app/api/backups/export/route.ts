import { exportBackupJson } from "@/server/services/backups";
import { handleError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const json = await exportBackupJson();
    return new Response(json, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="cubby-backup-${new Date().toISOString().slice(0, 10)}.json"`
      }
    });
  } catch (error) {
    return handleError(error);
  }
}
