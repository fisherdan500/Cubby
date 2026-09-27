import { readBoundedBytes } from "@/server/http";
import { withBackupUploadAdmission } from "@/server/services/backup-upload";

// Existing 100 MiB file allowance plus 1 MiB for the multipart envelope/fields.
export async function withSproutUpload<T>(request: Request, preview: boolean, work: (form: FormData) => Promise<T>): Promise<T> {
  return withBackupUploadAdmission(async () => {
    const bytes = await readBoundedBytes(request, (preview ? 101 : 1) * 1024 * 1024, "file_too_large");
    const form = await new Request(request.url, {
      method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" }, body: new Uint8Array(bytes)
    }).formData();
    return work(form);
  });
}
