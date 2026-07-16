import { handleError } from "@/server/http";
import { downloadLocalBackupFile } from "@/server/services/backups";

export const dynamic = "force-dynamic";

function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
}

export async function GET(_request: Request, context: { params: { filename: string } }) {
  try {
    const file = await downloadLocalBackupFile(context.params.filename);
    return new Response(file.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": contentDisposition(file.filename),
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return handleError(error);
  }
}
