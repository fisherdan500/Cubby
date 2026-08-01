import { execFile as execFileCallback } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const runExecFile = promisify(execFileCallback);

const DEFAULT_DIRECTORY = "/var/lib/cubby/sprout-staging";
const DOCKER_SECRET_KEY_FILE = "/run/secrets/cubby_sprout_staging_key";
const DEFAULT_KEY_VERSION = "v1";
const STAGED_FILENAME_PATTERN = /^sprout-stage-[a-f0-9]{32}\.bin$/;
const SPROUT_STAGING_UNLINK_HELPER = "/usr/local/bin/cubby-sprout-stage-unlink";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type SproutStagingConfig = {
  directory: string;
  keyFile: string;
  keyVersion: string;
};

export type StagedSproutBytes = {
  stagedFilename: string;
  stagedNonce: string;
  stagedAuthTag: string;
  stagedKeyVersion: string;
  sourceDigest: string;
};

export class SproutStagingWriteError extends Error {
  constructor(readonly stagedFilename: string) {
    super("sprout_staging_unavailable");
  }
}

type EnvSource = Partial<
  Record<"SPROUT_STAGING_DIRECTORY" | "SPROUT_STAGING_KEY_FILE" | "SPROUT_STAGING_KEY_VERSION", string | undefined>
>;

export function readSproutStagingConfig(source: EnvSource): SproutStagingConfig {
  const directory = readDirectory(source.SPROUT_STAGING_DIRECTORY);
  const keyFile = readKeyFile(source.SPROUT_STAGING_KEY_FILE);
  const keyVersion = source.SPROUT_STAGING_KEY_VERSION ?? DEFAULT_KEY_VERSION;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyVersion)) {
    throw new Error("SPROUT_STAGING_KEY_VERSION must be 1-64 URL-safe characters");
  }
  return { directory, keyFile, keyVersion };
}

function readDirectory(value: string | undefined) {
  const directory = value?.trim() || DEFAULT_DIRECTORY;
  if (
    directory === "/" ||
    /^[A-Za-z]:\\?$/.test(directory) ||
    directory.split(/[\\/]/).includes("..")
  ) {
    throw new Error("SPROUT_STAGING_DIRECTORY must be a non-root path without traversal");
  }
  return directory;
}

function readKeyFile(value: string | undefined) {
  const keyFile = value?.trim() || DOCKER_SECRET_KEY_FILE;
  if (!path.isAbsolute(keyFile) || keyFile === path.parse(keyFile).root || keyFile.split(/[\\/]/).includes("..")) {
    throw new Error("SPROUT_STAGING_KEY_FILE must be an absolute non-root path without traversal");
  }
  return keyFile;
}

export async function loadSproutStagingKey(config: SproutStagingConfig) {
  let raw: string;
  try {
    raw = (await readFile(config.keyFile, "utf8")).trim();
  } catch {
    throw new Error("sprout_staging_key_unavailable");
  }
  if (!BASE64_PATTERN.test(raw)) throw new Error("sprout_staging_key_invalid");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) throw new Error("sprout_staging_key_invalid");
  return key;
}

export function createSproutStagedFilename() {
  return `sprout-stage-${randomBytes(16).toString("hex")}.bin`;
}

export async function stageSproutBytes(
  bytes: Buffer,
  config: SproutStagingConfig,
  stagedFilename = createSproutStagedFilename()
): Promise<StagedSproutBytes> {
  const key = await loadSproutStagingKey(config);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const resolved = await stagedPath(config, stagedFilename, true);

  try {
    const handle = await open(resolved, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(ciphertext);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw new SproutStagingWriteError(stagedFilename);
  }

  return {
    stagedFilename,
    stagedNonce: nonce.toString("base64"),
    stagedAuthTag: cipher.getAuthTag().toString("base64"),
    stagedKeyVersion: config.keyVersion,
    sourceDigest: createHash("sha256").update(bytes).digest("hex")
  };
}

export async function readStagedSproutBytes(staged: StagedSproutBytes, config: SproutStagingConfig) {
  if (staged.stagedKeyVersion !== config.keyVersion) throw new Error("sprout_staging_key_version_mismatch");
  const nonce = decodeBase64(staged.stagedNonce, 12);
  const authTag = decodeBase64(staged.stagedAuthTag, 16);
  const key = await loadSproutStagingKey(config);
  const resolved = await stagedPath(config, staged.stagedFilename, false);

  let ciphertext: Buffer;
  try {
    const stats = await lstat(resolved);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("invalid");
    const handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) throw new Error("invalid");
      ciphertext = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("sprout_staging_unavailable");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (createHash("sha256").update(plaintext).digest("hex") !== staged.sourceDigest) {
      throw new Error("digest");
    }
    return plaintext;
  } catch {
    throw new Error("sprout_staging_invalid");
  }
}

export type SproutStagingExecFile = (
  file: string,
  args: string[],
  options: { windowsHide: boolean }
) => Promise<unknown>;

export type RemoveStagedSproutBytesOptions = {
  platform?: NodeJS.Platform;
  execFile?: SproutStagingExecFile;
};

export async function removeStagedSproutBytes(
  stagedFilename: string,
  config: SproutStagingConfig,
  options: RemoveStagedSproutBytesOptions = {}
) {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("sprout_staging_unavailable");
  if (!STAGED_FILENAME_PATTERN.test(stagedFilename)) throw new Error("sprout_staging_invalid");

  try {
    await (options.execFile ?? runExecFile)(
      SPROUT_STAGING_UNLINK_HELPER,
      [config.directory, stagedFilename],
      { windowsHide: true }
    );
  } catch {
    throw new Error("sprout_staging_unavailable");
  }
}

function decodeBase64(value: string, expectedLength: number) {
  if (!BASE64_PATTERN.test(value)) throw new Error("sprout_staging_invalid");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedLength || decoded.toString("base64") !== value) {
    throw new Error("sprout_staging_invalid");
  }
  return decoded;
}

async function stagedPath(config: SproutStagingConfig, filename: string, createRoot: boolean) {
  if (!STAGED_FILENAME_PATTERN.test(filename)) throw new Error("sprout_staging_invalid");
  const root = path.resolve(config.directory);
  if (root === path.parse(root).root) throw new Error("sprout_staging_unavailable");
  if (createRoot) await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw new Error("sprout_staging_unavailable");
  const resolved = path.resolve(root, filename);
  if (!resolved.startsWith(root + path.sep)) throw new Error("sprout_staging_invalid");
  return resolved;
}
