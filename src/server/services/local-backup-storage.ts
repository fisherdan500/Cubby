import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, opendir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { backupSummary, MAX_BACKUP_BYTES, parseBackup } from "@/server/services/backup-format";

const MAX_SCAN_CANDIDATES = 500;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const BACKUP_FILE_PATTERN = /^cubby-backup-v2-(\d{8}T\d{6}Z)-([a-f0-9]{12})(?:-([a-f0-9]{32}))?\.json$/;
const BACKUP_TEMP_PATTERN = /^\.cubby-backup-v2-\d{8}T\d{6}Z-[a-f0-9]{12}(?:-[a-f0-9]{32})?\.json\.[A-Za-z0-9_-]+\.tmp$/;

export function isLocalBackupFilename(filename: string) {
  return BACKUP_FILE_PATTERN.test(filename);
}

type PublishLocalBackupOptions = {
  filenameDiscriminator?: string;
  afterRootValidated?: () => void | Promise<void>;
  afterTempFileSynced?: () => void | Promise<void>;
  afterFinalLinked?: () => void | Promise<void>;
  beforeFinalRead?: () => void | Promise<void>;
  afterFailedTempUnlinked?: () => void | Promise<void>;
};

type RemoveLocalBackupOptions = {
  beforeUnlink?: () => void | Promise<void>;
};

type ReconcileLocalBackupTempOptions = {
  beforeUnlink?: (filename: string) => void | Promise<void>;
};

type TrustedBackupRoot = {
  resolvedRoot: string;
  dev: number;
  ino: number;
};

export type StoredBackupFile = {
  filename: string;
  absolutePath: string;
  size: number;
  checksum: string;
  exportedAt: string;
  householdName: string;
  itemCount: number;
};

export type ScannedBackupFile =
  | ({ healthy: true } & StoredBackupFile)
  | { healthy: false; filename: string; errorCode: string };

export function formatBackupFilename(exportedAt: string, checksum: string, discriminator?: string) {
  const stamp = exportedAt.replace(/[-:]/g, "").replace(".000", "").replace(/\.\d{3}Z$/, "Z");
  if (
    !/^\d{8}T\d{6}Z$/.test(stamp) ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    (discriminator !== undefined && !/^[a-f0-9]{32}$/.test(discriminator))
  ) {
    throw new Error("backup_invalid");
  }
  return `cubby-backup-v2-${stamp}-${checksum.slice(0, 12)}${discriminator ? `-${discriminator}` : ""}.json`;
}

export function resolveBackupRoot(root: string) {
  const normalized = path.resolve(root);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) throw new Error("backup_directory_unavailable");
  return normalized;
}

async function validateBackupRootComponents(resolvedRoot: string, allowMissing: boolean) {
  const parsed = path.parse(resolvedRoot);
  const segments = resolvedRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (missing) continue;
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("backup_directory_unavailable");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT" && allowMissing) {
        missing = true;
        continue;
      }
      throw error;
    }
  }
  return missing;
}

async function assertTrustedBackupRoot(root: string, create: boolean): Promise<TrustedBackupRoot> {
  const resolvedRoot = resolveBackupRoot(root);
  const missing = await validateBackupRootComponents(resolvedRoot, create);
  if (missing) await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  await validateBackupRootComponents(resolvedRoot, false);
  const rootStats = await lstat(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("backup_directory_unavailable");
  return { resolvedRoot, dev: rootStats.dev, ino: rootStats.ino };
}

async function assertTrustedBackupRootIdentity(root: TrustedBackupRoot) {
  await validateBackupRootComponents(root.resolvedRoot, false);
  const stats = await lstat(root.resolvedRoot);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== root.dev ||
    stats.ino !== root.ino
  ) {
    throw new Error("backup_directory_unavailable");
  }
}

async function syncBackupRoot(root: string) {
  let handle;
  try {
    handle = await open(root, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(String(code))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sanitizeStorageError(error: unknown) {
  if (error instanceof Error && /^backup_[a-z0-9_]+$/.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return "backup_already_exists";
  return "backup_write_failed";
}

function sanitizeReadError(error: unknown) {
  if (error instanceof Error && /^backup_[a-z0-9_]+$/.test(error.message)) return error.message;
  return "backup_invalid";
}

export async function publishLocalBackup(root: string, json: string, options: PublishLocalBackupOptions = {}) {
  if (Buffer.byteLength(json, "utf8") > MAX_BACKUP_BYTES) throw new Error("backup_too_large");
  let backup;
  try {
    backup = parseBackup(JSON.parse(json));
  } catch (error) {
    throw new Error(sanitizeReadError(error));
  }
  if (backup.version !== 2) throw new Error("backup_invalid");

  const trustedRoot = await assertTrustedBackupRoot(root, true);
  const { resolvedRoot } = trustedRoot;
  const filename = formatBackupFilename(
    backup.backup.exportedAt,
    backup.backup.checksum,
    options.filenameDiscriminator
  );
  const finalPath = path.join(resolvedRoot, filename);
  const tempPath = path.join(resolvedRoot, `.${filename}.${randomBytes(8).toString("hex")}.tmp`);

  let file;
  let linked = false;
  try {
    await assertTrustedBackupRootIdentity(trustedRoot);
    await options.afterRootValidated?.();
    await assertTrustedBackupRootIdentity(trustedRoot);
    file = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await assertTrustedBackupRootIdentity(trustedRoot);
    await file.writeFile(json, "utf8");
    await file.sync();
    await options.afterTempFileSynced?.();
    await assertTrustedBackupRootIdentity(trustedRoot);
    await file.close();
    await link(tempPath, finalPath);
    linked = true;
    await options.afterFinalLinked?.();
    await assertTrustedBackupRootIdentity(trustedRoot);
    await syncBackupRoot(resolvedRoot);
    await assertTrustedBackupRootIdentity(trustedRoot);
    await unlink(tempPath);
    await assertTrustedBackupRootIdentity(trustedRoot);
    await syncBackupRoot(resolvedRoot);
    await options.beforeFinalRead?.();
    await assertTrustedBackupRootIdentity(trustedRoot);
    return (await readLocalBackupDocumentFromTrustedRoot(trustedRoot, filename)).file;
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    const rootIsTrusted = await assertTrustedBackupRootIdentity(trustedRoot).then(() => true, () => false);
    if (rootIsTrusted) {
      await unlink(tempPath).catch(() => undefined);
      await options.afterFailedTempUnlinked?.();
      const rootStillTrusted = await assertTrustedBackupRootIdentity(trustedRoot).then(() => true, () => false);
      if (linked && rootStillTrusted) {
        await unlink(finalPath).catch(() => undefined);
        await assertTrustedBackupRootIdentity(trustedRoot).catch(() => undefined);
      }
    }
    throw new Error(sanitizeStorageError(error));
  }
}

export async function readLocalBackup(root: string, filename: string): Promise<StoredBackupFile> {
  return (await readLocalBackupDocument(root, filename)).file;
}

export async function readLocalBackupDocument(root: string, filename: string) {
  try {
    const trustedRoot = await assertTrustedBackupRoot(root, false);
    return await readLocalBackupDocumentFromTrustedRoot(trustedRoot, filename);
  } catch (error) {
    throw new Error(sanitizeReadError(error));
  }
}

async function readLocalBackupDocumentFromTrustedRoot(trustedRoot: TrustedBackupRoot, filename: string) {
  let handle;
  try {
    const filenameMatch = BACKUP_FILE_PATTERN.exec(filename);
    if (!filenameMatch) throw new Error("backup_invalid");
    const { resolvedRoot } = trustedRoot;
    const resolved = path.resolve(resolvedRoot, filename);
    if (!resolved.startsWith(resolvedRoot + path.sep)) throw new Error("backup_invalid");
    await assertTrustedBackupRootIdentity(trustedRoot);
    const beforeOpen = await lstat(resolved);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) throw new Error("backup_invalid");
    handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    await assertTrustedBackupRootIdentity(trustedRoot);
    const stats = await handle.stat();
    const afterOpen = await lstat(resolved);
    const sameIdentity = (candidate: typeof stats) =>
      candidate.isFile() &&
      !candidate.isSymbolicLink() &&
      candidate.dev === stats.dev &&
      candidate.ino === stats.ino;
    if (!sameIdentity(beforeOpen) || !sameIdentity(afterOpen)) throw new Error("backup_invalid");
    if (!stats.isFile() || stats.size > MAX_BACKUP_BYTES) {
      throw new Error(stats.size > MAX_BACKUP_BYTES ? "backup_too_large" : "backup_invalid");
    }
    const body = await handle.readFile();
    const parsed = parseBackup(JSON.parse(body.toString("utf8")));
    if (parsed.version !== 2) throw new Error("backup_invalid");
    if (formatBackupFilename(parsed.backup.exportedAt, parsed.backup.checksum, filenameMatch[3]) !== filename) {
      throw new Error("backup_invalid");
    }
    await assertTrustedBackupRootIdentity(trustedRoot);
    return {
      file: {
        filename,
        absolutePath: resolved,
        size: stats.size,
        checksum: parsed.backup.checksum,
        exportedAt: parsed.backup.exportedAt,
        householdName: parsed.backup.payload.household.name,
        itemCount: Object.values(backupSummary(parsed).counts as Record<string, number>)
          .reduce((total, count) => total + count, 0)
      },
      body
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function removeLocalBackup(
  root: string,
  filename: string,
  options: RemoveLocalBackupOptions = {}
) {
  const trustedRoot = await assertTrustedBackupRoot(root, false);
  const file = (await readLocalBackupDocumentFromTrustedRoot(trustedRoot, filename)).file;
  await options.beforeUnlink?.();
  await assertTrustedBackupRootIdentity(trustedRoot);
  await rm(file.absolutePath, { force: false });
  await assertTrustedBackupRootIdentity(trustedRoot);
}

export async function reconcileLocalBackupTemps(
  root: string,
  now = new Date(),
  options: ReconcileLocalBackupTempOptions = {}
) {
  const trustedRoot = await assertTrustedBackupRoot(root, false);
  const { resolvedRoot } = trustedRoot;
  await assertTrustedBackupRootIdentity(trustedRoot);
  const dir = await opendir(resolvedRoot);
  for await (const entry of dir) {
    if (!entry.isFile() || !BACKUP_TEMP_PATTERN.test(entry.name)) continue;
    const tempPath = path.join(resolvedRoot, entry.name);
    const stats = await lstat(tempPath).catch(() => null);
    if (stats && now.getTime() - stats.mtimeMs >= STALE_TEMP_MS) {
      await options.beforeUnlink?.(entry.name);
      await assertTrustedBackupRootIdentity(trustedRoot);
      await unlink(tempPath);
      await assertTrustedBackupRootIdentity(trustedRoot);
    }
  }
}

export async function scanLocalBackups(root: string, allowedFilenames?: readonly string[]) {
  let trustedRoot;
  try {
    trustedRoot = await assertTrustedBackupRoot(root, false);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const { resolvedRoot } = trustedRoot;
  const allowed = allowedFilenames ? new Set(allowedFilenames) : null;
  await assertTrustedBackupRootIdentity(trustedRoot);
  const dir = await opendir(resolvedRoot);

  const results: ScannedBackupFile[] = [];
  let seen = 0;
  for await (const entry of dir) {
    if (!BACKUP_FILE_PATTERN.test(entry.name)) continue;
    if (allowed && !allowed.has(entry.name)) continue;
    if (seen >= MAX_SCAN_CANDIDATES) break;
    seen += 1;
    await assertTrustedBackupRootIdentity(trustedRoot);
    try {
      const file = (await readLocalBackupDocumentFromTrustedRoot(trustedRoot, entry.name)).file;
      await assertTrustedBackupRootIdentity(trustedRoot);
      results.push({ healthy: true, ...file });
    } catch (error) {
      await assertTrustedBackupRootIdentity(trustedRoot);
      results.push({
        healthy: false,
        filename: entry.name,
        errorCode: sanitizeReadError(error)
      });
    }
  }

  return results.sort((a, b) => b.filename.localeCompare(a.filename));
}
