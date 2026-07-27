import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  startBackup: vi.fn(),
  startIntegrity: vi.fn()
}));

vi.mock("@/server/automated-backup-scheduler", () => ({
  startAutomatedBackupScheduler: mocks.startBackup
}));
vi.mock("@/server/integrity-scheduler", () => ({
  startIntegrityScheduler: mocks.startIntegrity
}));

describe("instrumentation", () => {
  it("enables the Next.js production instrumentation hook", async () => {
    const config = await readFile(path.join(process.cwd(), "next.config.mjs"), "utf8");
    expect(config).toMatch(/instrumentationHook:\s*true/);
  });

  it("starts enabled scheduler modules only in node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("@/instrumentation");
    await register();
    expect(mocks.startBackup).toHaveBeenCalledOnce();
    expect(mocks.startIntegrity).toHaveBeenCalledOnce();
  });
});
