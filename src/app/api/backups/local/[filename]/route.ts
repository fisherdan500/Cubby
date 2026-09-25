import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { handleError } from "@/server/http";
import { downloadLocalBackupFile } from "@/server/services/backups";

export const dynamic = "force-dynamic";

function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
}

export async function GET(_request: Request, context: { params: { filename: string } }) {
  try {
    const file = await downloadLocalBackupFile(context.params.filename);
    if ("archivePath" in file) {
      // A backup with photos (DEC-PROD-422) is streamed from disk rather than read into memory.
      const stream = Readable.toWeb(createReadStream(file.archivePath)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(file.size),
          "content-disposition": contentDisposition(file.filename),
          "cache-control": "no-store"
        }
      });
    }
    return new Response(new Uint8Array(file.body), {
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
