import { exportBackupJson } from "@/server/services/backups";
import { handleError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const json = await exportBackupJson();
    return new Response(json, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="cubby-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
}
