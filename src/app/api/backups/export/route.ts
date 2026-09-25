import { exportBackupForDownload } from "@/server/services/backups";
import { handleError } from "@/server/http";

export const dynamic = "force-dynamic";

/** The household backup: one JSON file, or - once it has photos - one archive with them (DEC-PROD-422). */
export async function POST() {
  try {
    const download = await exportBackupForDownload();
    const headers = {
      "content-disposition": `attachment; filename="${download.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    if (download.kind === "archive") {
      return new Response(download.stream, { headers: { ...headers, "content-type": "application/zip" } });
    }
    return new Response(download.body, { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
}
