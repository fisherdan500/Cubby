import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSproutStagingKey,
  readSproutStagingConfig,
  readStagedSproutBytes,
  removeStagedSproutBytes,
  stageSproutBytes,
  type SproutStagingConfig
} from "@/server/services/sprout-staging";

const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cubby-sprout-staging-"));
  directories.push(directory);
  const keyFile = path.join(directory, "test-key");
  const config: SproutStagingConfig = { directory, keyFile, keyVersion: "test-v1" };
  return { directory, keyFile, config };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Sprout encrypted staging", () => {
  it("defaults to the Docker secret mount, permits an explicit absolute secret file, and rejects unsafe staging configuration", () => {
    expect(readSproutStagingConfig({})).toEqual({
      directory: "/var/lib/cubby/sprout-staging",
      keyFile: "/run/secrets/cubby_sprout_staging_key",
      keyVersion: "v1"
    });
    expect(readSproutStagingConfig({ SPROUT_STAGING_KEY_FILE: "C:\\temp\\cubby-sprout-key" }).keyFile).toBe("C:\\temp\\cubby-sprout-key");
    expect(() => readSproutStagingConfig({ SPROUT_STAGING_DIRECTORY: "../outside" })).toThrow("SPROUT_STAGING_DIRECTORY");
    expect(() => readSproutStagingConfig({ SPROUT_STAGING_KEY_FILE: "../outside" })).toThrow("SPROUT_STAGING_KEY_FILE");
    expect(() => readSproutStagingConfig({ SPROUT_STAGING_KEY_VERSION: "" })).toThrow("SPROUT_STAGING_KEY_VERSION");
  });

  it("fails closed when the Docker-secret key file is missing or invalid", async () => {
    const { keyFile, config } = await setup();

    await expect(loadSproutStagingKey(config)).rejects.toThrow("sprout_staging_key_unavailable");

    await writeFile(keyFile, "not-a-32-byte-base64-key\n", { mode: 0o600 });
    await expect(loadSproutStagingKey(config)).rejects.toThrow("sprout_staging_key_invalid");
  });

  it("persists ciphertext rather than reviewed plaintext and decrypts only with matching metadata", async () => {
    const { directory, keyFile, config } = await setup();
    await writeFile(keyFile, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
    const plaintext = Buffer.from('{"data":{"Baby":[{"id":"reviewed-source"}]}}', "utf8");

    const staged = await stageSproutBytes(plaintext, config);
    const stored = await readFile(path.join(directory, staged.stagedFilename));

    expect(staged.stagedFilename).toMatch(/^sprout-stage-[a-f0-9]{32}\.bin$/);
    expect(staged.stagedKeyVersion).toBe("test-v1");
    expect(staged.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toContain(plaintext);
    await expect(readStagedSproutBytes(staged, config)).resolves.toEqual(plaintext);
  });

  it("delegates Linux staged-file deletion to the packaged descriptor-relative helper", async () => {
    const { directory, config } = await setup();
    const filename = "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin";
    const execFile = vi.fn().mockResolvedValue(undefined);

    await expect(removeStagedSproutBytes(filename, config, { platform: "linux", execFile })).resolves.toBeUndefined();

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "/usr/local/bin/cubby-sprout-stage-unlink",
      [directory, filename],
      { windowsHide: true }
    );
  });

  it("makes descriptor-relative cleanup idempotent when an earlier unlink succeeded before receipt finalization", async () => {
    const helper = await readFile(new URL("../../../docker/sprout-stage-unlink.c", import.meta.url), "utf8");

    expect(helper).toMatch(/#include <errno\.h>/);
    expect(helper).toMatch(/fstatat\([\s\S]*?\) != 0\) \{\s*if \(errno == ENOENT\) \{\s*close\(directory_fd\);\s*return 0;/);
  });

  it("fails closed without invoking a helper or unlinking staged bytes outside Linux", async () => {
    const { directory, config } = await setup();
    const filename = "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin";
    const stagedFile = path.join(directory, filename);
    const execFile = vi.fn().mockResolvedValue(undefined);
    await writeFile(stagedFile, "ciphertext");

    await expect(removeStagedSproutBytes(filename, config, { platform: "win32", execFile })).rejects.toThrow("sprout_staging_unavailable");

    expect(execFile).not.toHaveBeenCalled();
    await expect(access(stagedFile)).resolves.toBeUndefined();
  });
});
