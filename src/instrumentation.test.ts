import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  start: vi.fn()
}));

vi.mock("@/server/automated-backup-scheduler", () => ({
  startAutomatedBackupScheduler: mocks.start
}));

describe("instrumentation", () => {
  it("enables the Next.js production instrumentation hook", async () => {
    const config = await readFile(path.join(process.cwd(), "next.config.mjs"), "utf8");
    expect(config).toMatch(/instrumentationHook:\s*true/);
  });

  it("starts the scheduler only in node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("@/instrumentation");
    await register();
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
