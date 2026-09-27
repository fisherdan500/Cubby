// Shared across route bundles; the supported store has one app process.
const state = globalThis as typeof globalThis & { cubbyPhotoUploadActive?: boolean };
export async function withPhotoUploadAdmission<T>(work: () => Promise<T>): Promise<T> {
  if (state.cubbyPhotoUploadActive) throw new Error("attachment_upload_busy");
  state.cubbyPhotoUploadActive = true;
  try { return await work(); }
  finally { state.cubbyPhotoUploadActive = false; }
}
