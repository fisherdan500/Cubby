const DEFAULT_DIRECTORY = "/var/lib/cubby/attachments";

export type AttachmentConfig = { directory: string };

/**
 * Where the private attachment store lives: a server-controlled directory on the data volume, never
 * inside the served application (DEC-PROD-143, DEC-PROD-422).
 */
export function readAttachmentConfig(source: { ATTACHMENT_DIRECTORY?: string }): AttachmentConfig {
  const value = source.ATTACHMENT_DIRECTORY;
  if (value === undefined) return { directory: DEFAULT_DIRECTORY };
  const trimmed = value.trim();
  if (!trimmed) throw new Error("ATTACHMENT_DIRECTORY must not be blank");
  if (trimmed === "/" || /^[A-Za-z]:\\?$/.test(trimmed)) throw new Error("ATTACHMENT_DIRECTORY must not be a filesystem root");
  if (trimmed.includes("..")) throw new Error("ATTACHMENT_DIRECTORY must not contain relative traversal");
  return { directory: trimmed };
}
